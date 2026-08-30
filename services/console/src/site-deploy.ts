import { nowSec, systemClock, type Clock, type Logger } from "@yyt/core";
import type { SiteDeployRow, SiteRow, SitesDb } from "@yyt/console-db";
import type { SiteObjectHeaders, SiteStore } from "./site-store.js";
import { readSiteZip, ZipError, type ZipErrorCode } from "./zip.js";

/*
 * The site deploy worker (`siteDeploy` Lambda, async invoke) and the shared
 * constants the routes, the sweep and the tests use. Everything here is
 * pure over `SitesDb` + `SiteStore`, so the whole flow runs in vitest.
 */

/** Zip upload cap (decision 4). Presign signs it; commit and the worker re-check. */
export const SITE_MAX_ZIP_BYTES = 5 * 1024 * 1024;
/** Worker caps on what the zip may expand to. */
export const SITE_MAX_FILES = 2000;
export const SITE_MAX_EXTRACTED_BYTES = 50 * 1024 * 1024;
/** Deploy grants per site per hour; a shell loop must not buy invalidations. */
export const SITE_DEPLOYS_PER_HOUR = 20;
/**
 * An `extracting` deploy untouched for this long lost its worker (the Lambda
 * timeout is 300 s): every read of the site heals it to `failed` and frees
 * the claim. The same window heals a delete that died holding the claim.
 */
export const SITE_STALE_SEC = 15 * 60;
/**
 * A `queued` deploy waits in Lambda's async queue while the single worker
 * slot is busy (throttles are retried for hours, whatever
 * `maximumRetryAttempts` says), so it is only stale after a much longer
 * silence than an `extracting` one.
 */
export const SITE_QUEUED_STALE_SEC = 60 * 60;
/** Staging zips older than this are garbage whatever row they belong to. */
export const SITE_STAGING_GRACE_SEC = 2 * 60 * 60;
/** Per member per hour, across every site (`SITE_DEPLOYS_PER_HOUR` is per site). */
export const SITE_DEPLOYS_PER_MEMBER_HOUR = 60;
/** Claim value a delete holds on the site row while it wipes the prefix. */
export const SITE_DELETING = "delete";
/** Staging keys, in the private bucket. */
export const SITE_STAGING_PREFIX = "site-uploads/";
/** Slug grammar: opaque, lowercase, fixed length — and an S3 key prefix. */
export const SLUG = /^[a-z0-9]{9}$/;

export const siteStagingKey = (deployId: string) =>
  `${SITE_STAGING_PREFIX}${deployId}.zip`;

/**
 * Extension → `Content-Type`. Unlike assets this is not a security boundary
 * (the host exists to serve HTML); it only keeps browsers from guessing.
 * Unknown extensions are `application/octet-stream`, never refused.
 */
export const SITE_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".unityweb": "application/octet-stream",
  ".pck": "application/octet-stream",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8",
};
const ENCODINGS: Record<string, string> = { ".br": "br", ".gz": "gzip" };
/** Always revalidated: the entry points and anything a build rewrites in place. */
const NO_CACHE = new Set([".html", ".htm", ".json", ".webmanifest"]);
/** Where bundlers put content-hashed output. */
const HASHED_DIRS = ["assets/", "_app/immutable/", "static/", "_next/static/"];
/** `name-B3xk9Qz1.js`, `chunk.a1b2c3d4e5.css`: a hash token before the extension. */
const HASHED_NAME = /[-.][A-Za-z0-9_]{8,}\.[A-Za-z0-9]+$/;

const ext = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
};

/** Headers for one published file, by its path inside the site. */
export function siteObjectHeaders(path: string): SiteObjectHeaders {
  let name = path.slice(path.lastIndexOf("/") + 1);
  const encoding = ENCODINGS[ext(name)];
  if (encoding) name = name.slice(0, name.lastIndexOf("."));
  const e = ext(name);
  const contentType = SITE_CONTENT_TYPES[e] ?? "application/octet-stream";
  let cacheControl = "public, max-age=300";
  if (NO_CACHE.has(e)) cacheControl = "no-cache";
  else if (
    HASHED_DIRS.some((d) => path.startsWith(d)) &&
    HASHED_NAME.test(name)
  )
    cacheControl = "public, max-age=31536000, immutable";
  return {
    contentType,
    cacheControl,
    ...(encoding ? { contentEncoding: encoding } : {}),
  };
}

export interface SiteDeployDeps {
  sites: SitesDb;
  store: SiteStore;
  clock?: Clock;
  logger: Logger;
  /** Parallel S3 PUTs. */
  concurrency?: number;
}

/**
 * Failure codes a client may see in `deploy.error`, optionally followed by
 * `: detail` (a zip entry name, sanitised). Never a key, a bucket, or an SDK
 * message. A `live` row may carry `cdn_invalidation_failed`: the tree is up,
 * the edge was not told.
 */
export type SiteDeployError =
  | "worker_lost"
  | "invoke_failed"
  | "site_gone"
  | "zip_missing"
  | "storage_error"
  | "cdn_invalidation_failed"
  | ZipErrorCode;

/**
 * Runs one queued deploy to `live` or `failed`. **Never throws**: the function
 * has no Errors alarm and no retry, so a thrown error would leave the row
 * `queued` until the stale heal — every path ends in a status write.
 *
 * Order: write the new set, then prune keys not in it, then invalidate. The
 * previous tree keeps serving until the new one is complete, and a crash
 * midway leaves a mixed tree rather than an empty one.
 */
export async function runSiteDeploy(
  deployId: string,
  {
    sites,
    store,
    clock = systemClock,
    logger,
    concurrency = 8,
  }: SiteDeployDeps,
): Promise<SiteDeployRow | undefined> {
  const log = (m: string, meta: Record<string, unknown> = {}) =>
    logger.info(m, { deployId, ...meta });
  const deploy = await sites.findDeploy(deployId).catch(() => undefined);
  if (!deploy) {
    logger.warn("site deploy vanished", { deployId });
    return undefined;
  }
  if (deploy.status !== "queued") {
    // The sweep or a heal already judged it, or a duplicate event replays.
    log("site deploy not queued", { status: deploy.status });
    return deploy;
  }
  let site: SiteRow | undefined;
  try {
    site = await sites.findSite(deploy.siteId);
  } catch (e) {
    // A database blip is not "site gone": leave the row `queued` for the
    // stale heal rather than record a permanent, misleading failure.
    logger.error("site deploy cannot read the site", {
      deployId,
      message: e instanceof Error ? e.message : String(e),
    });
    return deploy;
  }

  const fail = async (
    error: SiteDeployError,
    from: "queued" | "extracting",
    detail?: string,
  ) => {
    const now = nowSec(clock);
    await sites
      .transitionDeploy(
        deployId,
        from,
        { status: "failed", error: errorText(error, detail) },
        now,
      )
      .catch(() => false);
    if (site)
      await sites.releaseSite(site.id, deployId, now).catch(() => false);
    await store.deleteZip(deploy.objectKey).catch(() => undefined);
    logger.warn("site deploy failed", {
      deployId,
      siteId: deploy.siteId,
      error,
      ...(detail ? { detail } : {}),
    });
    return sites.findDeploy(deployId).catch(() => undefined);
  };

  if (!site || site.activeDeployId !== deployId || !SLUG.test(site.slug))
    return fail("site_gone", "queued");
  if (
    !(await sites
      .transitionDeploy(
        deployId,
        "queued",
        { status: "extracting" },
        nowSec(clock),
      )
      .catch(() => false))
  )
    return sites.findDeploy(deployId).catch(() => undefined);

  const prefix = `${site.slug}/`;
  let files: { path: string; data: Buffer }[];
  try {
    const zip = await store.getZip(deploy.objectKey, SITE_MAX_ZIP_BYTES);
    files = readSiteZip(zip, {
      maxEntries: SITE_MAX_FILES,
      maxTotalBytes: SITE_MAX_EXTRACTED_BYTES,
    });
  } catch (e) {
    if (e instanceof ZipError) return fail(e.code, "extracting", e.detail);
    const code = (e as { code?: string }).code;
    return fail(
      code === "payload_too_large"
        ? "zip_too_large"
        : code === "not_found"
          ? "zip_missing"
          : "storage_error",
      "extracting",
    );
    // (no detail: the SDK message can quote the bucket or the key)
  }

  const wanted = new Set(files.map((f) => `${prefix}${f.path}`));
  // Belt and braces: the zip reader already refuses anything that could leave
  // the prefix, and an S3 write outside `{slug}/` is another team's site.
  for (const key of wanted)
    if (!key.startsWith(prefix) || key.includes("/../"))
      return fail("zip_path_rejected", "extracting", "prefix");

  let bytes = 0;
  try {
    const existing = await store.listKeys(prefix);
    const queue = [...files];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        await store.putFile(
          `${prefix}${f.path}`,
          f.data,
          siteObjectHeaders(f.path),
        );
        bytes += f.data.length;
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    // The site may have been deleted while we were writing; its delete
    // (which holds the claim now) wipes the prefix, so stop before `live`.
    const again = await sites.findSite(site.id);
    if (!again || again.activeDeployId !== deployId)
      return fail("site_gone", "extracting");
    const stale = existing.filter((k) => !wanted.has(k));
    if (stale.length > 0) await store.deleteKeys(stale);
    log("site files written", {
      files: files.length,
      bytes,
      pruned: stale.length,
    });
  } catch (e) {
    logger.warn("site deploy storage error", { deployId, name: errorName(e) });
    return fail("storage_error", "extracting");
  }

  // The tree is already replaced: a CDN failure here is a warning on a live
  // deploy, not a failed one (the edge catches up within its TTL or on the
  // next deploy). Failing would leave the console pointing at files that no
  // longer exist.
  let invalidated = false;
  let warning: SiteDeployError | null = null;
  try {
    invalidated = await store.invalidate([`/${site.slug}/*`]);
  } catch (e) {
    warning = "cdn_invalidation_failed";
    logger.warn("site deploy invalidation failed", {
      deployId,
      name: errorName(e),
    });
  }

  const now = nowSec(clock);
  const moved = await sites
    .transitionDeploy(
      deployId,
      "extracting",
      { status: "live", bytes, files: files.length, error: warning },
      now,
    )
    .catch(() => false);
  if (moved) {
    // The pointer is what the console shows; a miss here is visible (badge,
    // `currentDeploy`) and fixed by the next deploy — say so in the log.
    if (
      !(await sites
        .updateSite(site.id, { currentDeployId: deployId }, now)
        .catch(() => false))
    )
      logger.error("site current deploy pointer not updated", {
        deployId,
        siteId: site.id,
      });
    await sites.releaseSite(site.id, deployId, now).catch(() => false);
    await store.deleteZip(deploy.objectKey).catch(() => undefined);
    log("site deploy live", {
      siteId: site.id,
      files: files.length,
      bytes,
      invalidated,
    });
  }
  return sites.findDeploy(deployId).catch(() => undefined);
}

/**
 * Deploys that lost their worker: `extracting` untouched for
 * `SITE_STALE_SEC`, `queued` for `SITE_QUEUED_STALE_SEC`. Marked `failed` and
 * their claim on the site released. Called by every site read (a poller is
 * the only thing looking in time) and by the daily sweep.
 */
export async function healStaleDeploys(
  {
    sites,
    clock = systemClock,
    logger,
  }: Pick<SiteDeployDeps, "sites" | "clock" | "logger">,
  siteId?: string,
): Promise<number> {
  const now = nowSec(clock);
  const rows = [
    ...(await sites.listDeploysByStatus(
      ["extracting"],
      now - SITE_STALE_SEC,
      siteId,
    )),
    ...(await sites.listDeploysByStatus(
      ["queued"],
      now - SITE_QUEUED_STALE_SEC,
      siteId,
    )),
  ];
  let healed = 0;
  for (const d of rows) {
    const moved = await sites.transitionDeploy(
      d.id,
      d.status,
      { status: "failed", error: "worker_lost" },
      now,
    );
    if (!moved) continue;
    healed++;
    await sites.releaseSite(d.siteId, d.id, now);
    logger.warn("site deploy lost its worker", {
      deployId: d.id,
      siteId: d.siteId,
    });
  }
  return healed;
}

/**
 * A delete that died holding the claim (`SITE_DELETING`) would refuse every
 * later deploy and delete with 409; nothing else looks at it, so the site
 * reads release it after the stale window.
 */
export async function healStaleDelete(
  {
    sites,
    clock = systemClock,
    logger,
  }: Pick<SiteDeployDeps, "sites" | "clock" | "logger">,
  site: SiteRow,
): Promise<boolean> {
  const now = nowSec(clock);
  if (
    site.activeDeployId !== SITE_DELETING ||
    site.updatedAt >= now - SITE_STALE_SEC
  )
    return false;
  const released = await sites.releaseSite(site.id, SITE_DELETING, now);
  if (released)
    logger.warn("site delete lost its request; claim released", {
      siteId: site.id,
    });
  return released;
}

/**
 * Daily: expired presigns (row + staging zip), staging zips nothing will
 * read any more (their row is terminal, pending-expired, or gone — a deleted
 * site cascades its rows), then the stale heal.
 */
export async function runSiteSweep({
  sites,
  store,
  clock = systemClock,
  logger,
}: SiteDeployDeps): Promise<{
  expired: number;
  orphans: number;
  healed: number;
}> {
  const now = nowSec(clock);
  // Expired `pending` rows still name their staging object; drop it first,
  // since the row is the only thing that knows the key.
  const expired = await sites.listDeploysByStatus(["pending"], now);
  for (const d of expired) {
    if (d.expiresAt >= now) continue;
    await store.deleteZip(d.objectKey).catch((e: unknown) =>
      logger.warn("site staging zip delete failed", {
        deployId: d.id,
        message: e instanceof Error ? e.message : String(e),
      }),
    );
  }
  const dropped = await sites.deleteExpiredDeploys(now);
  // Age-based pass over the prefix: the rows cannot name every object (a
  // failed delete above, a deleted site's cascaded rows), so the object's
  // age decides, with the row consulted only to spare a deploy in flight.
  let orphans = 0;
  for (const z of await store.listZips()) {
    if (z.lastModifiedSec > now - SITE_STAGING_GRACE_SEC) continue;
    const id = z.key.slice(SITE_STAGING_PREFIX.length).replace(/\.zip$/, "");
    const row = await sites.findDeploy(id);
    if (row && (row.status === "queued" || row.status === "extracting"))
      continue;
    try {
      await store.deleteZip(z.key);
      orphans++;
    } catch (e) {
      logger.warn("site staging zip delete failed", {
        deployId: id,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const healed = await healStaleDeploys({ sites, clock, logger });
  logger.info("site sweep", { expired: dropped, orphans, healed });
  return { expired: dropped, orphans, healed };
}

/** Error class/name only: SDK messages can quote a bucket or a key. */
const errorName = (e: unknown) =>
  e instanceof Error
    ? `${e.name}${e.cause instanceof Error ? `/${e.cause.name}` : ""}`
    : String(e);

/** `code` or `code: detail`, the detail reduced to printable ASCII and bounded. */
export function errorText(code: SiteDeployError, detail?: string): string {
  if (!detail) return code;
  const clean = detail.replace(/[^\x20-\x7e]/g, "?").slice(0, 120);
  return `${code}: ${clean}`.slice(0, 255);
}

/** What a site looks like at the edge. */
export function sitePublicUrl(cdnBaseUrl: string, site: Pick<SiteRow, "slug">) {
  return `${cdnBaseUrl.replace(/\/+$/, "")}/${site.slug}/`;
}
