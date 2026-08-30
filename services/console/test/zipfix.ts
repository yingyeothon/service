import { crc32, deflateRawSync } from "node:zlib";

/*
 * A small zip writer for tests: enough of the format to produce what real
 * tools do (stored or deflated entries, data descriptors like Go's
 * `archive/zip`, unix modes for symlinks, directory entries, UTF-8 names)
 * and to forge what attackers do (lying sizes, zip64 markers, encryption).
 */

export interface ZipEntry {
  name: string;
  data?: Buffer | string;
  /** 0 = stored, 8 = deflate. */
  method?: 0 | 8;
  /** Go-style: sizes/CRC only in the descriptor and the central directory. */
  descriptor?: boolean;
  /** Unix mode (`0o120777` = symlink). */
  mode?: number;
  /** Extra general-purpose flag bits to set (0x0001 = encrypted). */
  flags?: number;
  /** Override the central-directory uncompressed size (a lying header). */
  claimUncompressed?: number;
  /** Override the central-directory compressed size. */
  claimCompressed?: number;
  /** Override the central-directory local-header offset. */
  forgeLocalOffset?: number;
}

const LOC = 0x04034b50;
const CEN = 0x02014b50;
const EOCD = 0x06054b50;
const DESC = 0x08074b50;

export function makeZip(
  entries: ZipEntry[],
  o: { comment?: string; eocdCount?: number } = {},
): Buffer {
  const parts: Buffer[] = [];
  const cds: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data)
      ? e.data
      : Buffer.from(e.data ?? "", "utf8");
    const method = e.method ?? (raw.length > 0 ? 8 : 0);
    const packed = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, "utf8");
    const utf8 = [...e.name].some((c) => c.charCodeAt(0) > 0x7f) ? 0x0800 : 0;
    const flags = (e.descriptor ? 0x0008 : 0) | utf8 | (e.flags ?? 0);
    const crc = crc32(raw);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(LOC, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(flags, 6);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt16LE(0, 10);
    loc.writeUInt16LE(0x21, 12);
    loc.writeUInt32LE(e.descriptor ? 0 : crc, 14);
    loc.writeUInt32LE(e.descriptor ? 0 : packed.length, 18);
    loc.writeUInt32LE(e.descriptor ? 0 : raw.length, 22);
    loc.writeUInt16LE(name.length, 26);
    loc.writeUInt16LE(0, 28);
    const chunks = [loc, name, packed];
    if (e.descriptor) {
      const d = Buffer.alloc(16);
      d.writeUInt32LE(DESC, 0);
      d.writeUInt32LE(crc, 4);
      d.writeUInt32LE(packed.length, 8);
      d.writeUInt32LE(raw.length, 12);
      chunks.push(d);
    }
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CEN, 0);
    cen.writeUInt16LE((3 << 8) | 20, 4); // made by unix
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(e.claimCompressed ?? packed.length, 20);
    cen.writeUInt32LE(e.claimUncompressed ?? raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    const mode = e.mode ?? (e.name.endsWith("/") ? 0o40755 : 0o100644);
    cen.writeUInt32LE((mode << 16) >>> 0, 38);
    cen.writeUInt32LE(e.forgeLocalOffset ?? offset, 42);
    cds.push(Buffer.concat([cen, name]));
    for (const c of chunks) {
      parts.push(c);
      offset += c.length;
    }
  }
  const cd = Buffer.concat(cds);
  const comment = Buffer.from(o.comment ?? "", "utf8");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(o.eocdCount ?? entries.length, 8);
  eocd.writeUInt16LE(o.eocdCount ?? entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...parts, cd, eocd, comment]);
}

/** A two-file site: `index.html` fetching `config.json`, plus a hashed asset. */
export function siteZip(marker = "one"): Buffer {
  return makeZip([
    {
      name: "index.html",
      data: `<!doctype html><script src="./assets/index-B3xk9Qz1.js"></script><p>${marker}</p>`,
    },
    { name: "config.json", data: JSON.stringify({ marker }) },
    { name: "assets/", data: "" },
    {
      name: "assets/index-B3xk9Qz1.js",
      data: "console.log(1)",
      descriptor: true,
    },
  ]);
}
