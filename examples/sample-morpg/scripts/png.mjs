// Minimal PNG codec for the asset packer: 8-bit RGBA, non-interlaced only.
// No dependency so the sample's package.json stays free of image libraries.
// Dev-time only (scripts/pack-assets.mjs on the owner's own files): no CRC or
// bounds hardening — never run it on untrusted input.
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @returns {{ width: number, height: number, data: Buffer }} RGBA, row-major, no padding */
export function decodePng(file) {
  if (!file.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (pos < file.length) {
    const len = file.readUInt32BE(pos);
    const type = file.toString("latin1", pos + 4, pos + 8);
    const body = file.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colour = body[9];
      const interlace = body[12];
      if (depth !== 8 || colour !== 6 || interlace !== 0)
        throw new Error(
          `unsupported PNG: depth ${depth} colour ${colour} interlace ${interlace} (need 8-bit RGBA, non-interlaced)`,
        );
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  if (raw.length !== (stride + 1) * height)
    throw new Error(
      `PNG data length ${raw.length} != ${(stride + 1) * height} (truncated or not 8-bit RGBA)`,
    );
  const data = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = data.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? out[i - 4] : 0;
      const b = prev[i];
      const c = i >= 4 ? prev[i - 4] : 0;
      let v;
      switch (filter) {
        case 0:
          v = line[i];
          break;
        case 1:
          v = line[i] + a;
          break;
        case 2:
          v = line[i] + b;
          break;
        case 3:
          v = line[i] + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`bad PNG filter ${filter} at row ${y}`);
      }
      out[i] = v & 0xff;
    }
    prev = out;
  }
  return { width, height, data };
}

/** Encodes RGBA pixels; filter 0 on every row, so the output is a pure function of the pixels. */
export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** Copies one `size`×`size` cell out of an RGBA image. */
export function cellPixels(img, col, row, size) {
  if ((col + 1) * size > img.width || (row + 1) * size > img.height)
    throw new Error(
      `cell ${col},${row} outside the ${img.width}x${img.height} image`,
    );
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = ((row * size + y) * img.width + col * size) * 4;
    img.data.copy(out, y * size * 4, src, src + size * 4);
  }
  return out;
}

export function blit(dst, pixels, col, row, size) {
  for (let y = 0; y < size; y++) {
    const off = ((row * size + y) * dst.width + col * size) * 4;
    pixels.copy(dst.data, off, y * size * 4, (y + 1) * size * 4);
  }
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
