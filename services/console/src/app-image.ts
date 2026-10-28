import { z } from "zod";

/*
 * An app's public preview image (docs/decisions.md *Catalog share links and
 * install bridge* #11): one PNG per app on the artifact CDN, keyed by its
 * hash. Pure helpers; the routes live with the other app writes in
 * `catalog.ts`.
 */

export const APP_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const APP_IMAGE_MIN_SIDE = 200;
export const APP_IMAGE_MAX_SIDE = 4096;
export const APP_IMAGE_TYPE = "image/png";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "lowercase hex SHA-256");
export const appImageBody = z
  .object({
    size: z.number().int().min(1).max(APP_IMAGE_MAX_BYTES),
    sha256,
  })
  .strict();
export const appImageCommitBody = z.object({ sha256 }).strict();

/** Served images: `immutable`, since a new image is a new key. */
export const APP_IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Where an app's images live on the CDN. */
export const appImagePrefix = (appId: string) => `apps/${appId}/images/`;
/** The CDN key: under the app's own prefix, named by the content. */
export const appImageKey = (appId: string, hash: string) =>
  `${appImagePrefix(appId)}${hash}.png`;
/**
 * The staging "upload id": no pending-upload row carries it, so the daily
 * `uploads/` sweep removes an image that was never committed.
 */
export const appImageUploadId = (hash: string) => `img-${hash}`;
export const appImageStagingKey = (hash: string) =>
  `uploads/${appImageUploadId(hash)}/image.png`;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * The dimensions a PNG declares, or why it is refused: the 8-byte signature,
 * then the first chunk must be `IHDR` (width and height at bytes 16–23).
 */
export function pngDimensions(
  bytes: Buffer,
): { width: number; height: number } | { error: string } {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    return { error: "not a PNG" };
  if (bytes.toString("latin1", 12, 16) !== "IHDR")
    return { error: "PNG without an IHDR header" };
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (
    Math.min(width, height) < APP_IMAGE_MIN_SIDE ||
    Math.max(width, height) > APP_IMAGE_MAX_SIDE
  )
    return {
      error: `image is ${width}×${height}; each side must be ${APP_IMAGE_MIN_SIDE}–${APP_IMAGE_MAX_SIDE} px`,
    };
  return { width, height };
}
