import { inflateRawSync } from "node:zlib";

/*
 * A minimal zip reader for site deploys: central directory driven (the CLI's
 * Go `archive/zip` writer emits data descriptors, so local headers carry no
 * sizes), stored and deflate only, every cap enforced *while* inflating. No
 * zip64, no encryption, no multi-disk — a build of a few MB never needs them,
 * and each is a way to make the sizes lie.
 */

export type ZipErrorCode =
  | "zip_not_a_zip"
  | "zip_unsupported"
  | "zip_corrupt"
  | "zip_too_many_entries"
  | "zip_too_large"
  | "zip_path_rejected"
  | "zip_no_index_html";

export class ZipError extends Error {
  constructor(
    readonly code: ZipErrorCode,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ZipError";
  }
}

export interface ZipFile {
  /** Normalised relative path with `/` separators. */
  path: string;
  data: Buffer;
}

export interface ZipLimits {
  maxEntries: number;
  /** Sum of inflated bytes over every kept entry. */
  maxTotalBytes: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
/** Longest EOCD: 22 bytes + 65535 of comment. */
const EOCD_SEARCH = 22 + 0xffff;

/**
 * One path segment of a site file: ASCII, no leading dot (dot-files are
 * dropped, never published), the characters real front-end builds emit
 * (`@`/`~`/`+`/`=`/`()`/`[]` for chunk names) and nothing that means
 * anything to a URL, a shell or S3. Non-ASCII is refused rather than
 * normalised: NFC/NFD twins would be two objects the prune cannot tell apart.
 */
const SEGMENT = /^[A-Za-z0-9_@~+=()[\]-][A-Za-z0-9._@~+=()[\]-]{0,127}$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const MAX_SEGMENTS = 16;
const MAX_PATH = 512;

/**
 * Validates and normalises one entry name. Returns `undefined` for entries
 * that are silently dropped (directories, dot-files and dot-directories,
 * `__MACOSX/`), throws for anything that could escape or alias a prefix.
 */
export function sitePath(name: string): string | undefined {
  if (name.endsWith("/")) return undefined; // directory entry
  if (name.length > MAX_PATH)
    throw new ZipError("zip_path_rejected", "path too long");
  if (name.includes("\\") || !PRINTABLE_ASCII.test(name))
    throw new ZipError("zip_path_rejected", name.slice(0, 80));
  const segments = name.split("/");
  if (segments.length > MAX_SEGMENTS)
    throw new ZipError("zip_path_rejected", "too many segments");
  for (const s of segments)
    if (s === "" || s === "." || s === "..")
      throw new ZipError("zip_path_rejected", name.slice(0, 80));
  // Anything under a dot-directory (`.git/`, `.svelte-kit/`) or Finder's
  // resource-fork folder is build residue, not a page.
  if (segments.some((s) => s.startsWith("."))) return undefined;
  if (segments[0] === "__MACOSX") return undefined;
  for (const s of segments)
    if (!SEGMENT.test(s))
      throw new ZipError("zip_path_rejected", name.slice(0, 80));
  return segments.join("/");
}

/** Unix mode in the high 16 bits of the external attributes: `S_IFLNK`. */
const isSymlink = (externalAttrs: number) =>
  ((externalAttrs >>> 16) & 0xf000) === 0xa000;

/**
 * Parses `buf` and returns the files to publish. Throws `ZipError`; never
 * returns a path that could leave the site prefix. When no `index.html` sits
 * at the root but every entry shares one top-level directory (a zipped
 * folder), that directory is stripped.
 */
export function readSiteZip(buf: Buffer, limits: ZipLimits): ZipFile[] {
  if (buf.length < 22) throw new ZipError("zip_not_a_zip");
  // EOCD: last occurrence of the signature within the comment window.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - EOCD_SEARCH; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("zip_not_a_zip");
  const diskNo = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (diskNo !== 0 || cdDisk !== 0)
    throw new ZipError("zip_unsupported", "multi-disk");
  // A zip64 archive stores 0xffff/0xffffffff here and a locator before the EOCD.
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw new ZipError("zip_unsupported", "zip64");
  // The entry cap is applied to kept files below: real zippers emit a
  // directory entry per folder, and those never become objects.
  if (cdOffset + cdSize > eocd) throw new ZipError("zip_corrupt", "cd bounds");

  const raw: { name: string; data: Buffer }[] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CEN_SIG)
      throw new ZipError("zip_corrupt", "cd entry");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const uncompressed = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > eocd) throw new ZipError("zip_corrupt", "cd name");
    // Names are UTF-8 when flag 11 is set, else cp437 — which is ASCII for
    // every name the segment rule accepts, so decoding as UTF-8 is exact for
    // accepted names and only changes the wording of a rejection.
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x0001) throw new ZipError("zip_unsupported", "encrypted");
    if (compressed === 0xffffffff || uncompressed === 0xffffffff)
      throw new ZipError("zip_unsupported", "zip64");
    if (isSymlink(externalAttrs)) continue;
    const path = sitePath(name);
    if (path === undefined) continue;

    // Local header: the sizes there may be zero (data descriptor); trust the
    // central directory, but bound the read by the archive.
    if (
      localOffset + 30 > cdOffset ||
      buf.readUInt32LE(localOffset) !== LOC_SIG
    )
      throw new ZipError("zip_corrupt", "local header");
    const locNameLen = buf.readUInt16LE(localOffset + 26);
    const locExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + locNameLen + locExtraLen;
    if (dataStart + compressed > cdOffset)
      throw new ZipError("zip_corrupt", "data bounds");
    const packed = buf.subarray(dataStart, dataStart + compressed);

    // The cap is checked before inflating with the declared size and
    // enforced during inflating with `maxOutputLength`: a lying header is
    // caught either way.
    const remaining = limits.maxTotalBytes - total;
    if (uncompressed > remaining) throw new ZipError("zip_too_large");
    let data: Buffer;
    if (method === 0) {
      if (compressed !== uncompressed)
        throw new ZipError("zip_corrupt", "stored size");
      data = Buffer.from(packed);
    } else if (method === 8) {
      try {
        data = inflateRawSync(packed, {
          maxOutputLength: Math.max(1, remaining),
        });
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "ERR_BUFFER_TOO_LARGE")
          throw new ZipError("zip_too_large");
        throw new ZipError("zip_corrupt", "inflate");
      }
      if (data.length !== uncompressed)
        throw new ZipError("zip_corrupt", "inflated size");
    } else throw new ZipError("zip_unsupported", `method ${method}`);
    total += data.length;
    if (total > limits.maxTotalBytes) throw new ZipError("zip_too_large");
    raw.push({ name: path, data });
  }
  if (raw.length > limits.maxEntries)
    throw new ZipError("zip_too_many_entries");

  // Unwrap a zipped folder: no root index.html, one shared top directory.
  let files = raw;
  if (!raw.some((f) => f.name === "index.html") && raw.length > 0) {
    const tops = new Set(raw.map((f) => f.name.split("/")[0]));
    const [top] = tops;
    if (
      tops.size === 1 &&
      top !== undefined &&
      raw.every((f) => f.name.includes("/"))
    )
      files = raw.map((f) => ({ ...f, name: f.name.slice(top.length + 1) }));
  }
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.name))
      throw new ZipError(
        "zip_path_rejected",
        `duplicate ${f.name.slice(0, 80)}`,
      );
    seen.add(f.name);
  }
  if (!seen.has("index.html")) throw new ZipError("zip_no_index_html");
  return files.map((f) => ({ path: f.name, data: f.data }));
}
