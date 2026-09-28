import { BUNDLE_SORT_KEYS } from "@yyt/console-db";
import {
  AppError,
  nowSec,
  randomHex,
  type Clock,
  type Logger,
} from "@yyt/core";
import type {
  AssetBundleRow,
  AssetFileRow,
  AssetsDb,
  AssetUploadRow,
  AssetVersionSummary,
  ConsoleDb,
  LimitsDb,
  LimitScope,
  TeamDb,
} from "@yyt/console-db";
import { defineRoute, type AnyRoute, type RouteContext } from "@yyt/http";
import { z } from "zod";
import { listParams, listQuery } from "./list-query.js";
import {
  formatLimitValue,
  LIMITS,
  overLimit,
  resolveLimits,
  type LimitKey,
} from "./limits.js";
import {
  ARTIFACT_UPLOAD_URL_TTL_SEC,
  type ArtifactStore,
  uploadGrant,
} from "./artifact-store.js";
import { artifactUrl } from "./catalog.js";
import { requireRole } from "./identity.js";
import type { TeamAccessHelpers, ResourceAccess } from "./team-access.js";
import { resourceName } from "./team.js";
import {
  type CrumbResolver,
  type ResourceHistory,
  asUploadOwner,
} from "./resources.js";

/** Committed asset objects; never touched by the catalog retention sweep. */
export const ASSET_KEY_PREFIX = "assets/";
/** Staging objects, swept like the catalog's `uploads/` prefix. */
export const ASSET_UPLOAD_KEY_PREFIX = "asset-uploads/";
/**
 * Objects are served `immutable` forever, so a bad file is fixed by publishing
 * a new version, never by overwriting one. The pointer to the live version is
 * the channel's `mapUrl`, so no CDN invalidation is ever needed.
 */
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
/*
 * Sizes and counts are limits with a soft and a hard value (`limits.ts`,
 * docs/decisions.md *Limit requests*): every bundle and project gets the soft
 * value, and an admin may grant one more. Every check counts committed rows
 * through the aggregates (`versionSummaries`, `projectAssetUsage`) plus the
 * presigns still in flight, and never loads a bundle's rows.
 */

/**
 * Extension → `Content-Type`, signed into the presigned PUT. The caller never
 * chooses the type: this bucket is fronted by our own CDN origin, so an
 * attacker-chosen `text/html` (or `image/svg+xml`, which scripts) would be
 * stored XSS on a domain the console and the game both trust
 * (`rules/security.md`).
 */
export const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

/** Versions become object-key and URL path segments. */
const bundlesQuery = listQuery(BUNDLE_SORT_KEYS).passthrough();
const filePageQuery = z
  .object({
    cursor: z.string().max(255).optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict();
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
/**
 * No dot: the bundle name is also a SPA route segment (`/ui/assets/{name}`) and
 * CloudFront's SPA rewrite treats any last-segment dot as a static file, so
 * `maps.v2` would resolve against the SPA's own `ui/assets/` chunk directory
 * instead of rendering the page. On top of that, the team-unique resource rule
 * (never id-shaped).
 */
const BUNDLE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const bundleName = resourceName.refine(
  (s) => BUNDLE_NAME.test(s),
  "letters, digits, _, - (max 64)",
);
const version = z.string().regex(SEGMENT, "letters, digits, ., _, - (max 64)");
const description = z.string().max(2000);

/**
 * A relative path inside the bundle: segments separated by `/`, no `.`/`..`,
 * no leading slash, no backslash. `..` would escape the version prefix and let
 * one bundle write over another's live objects.
 */
const RELATIVE_PATH =
  /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,63}(\/[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,63}){0,7}$/;

export function assetContentType(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  const type = ASSET_CONTENT_TYPES[ext];
  if (!type)
    throw new AppError(
      "bad_request",
      `file extension "${ext}" is not an allowed asset type`,
    );
  return type;
}

export const bundleCreateBody = z
  .object({ name: bundleName, description: description.optional() })
  .strict();
export const bundlePatchBody = z
  .object({
    name: bundleName.optional(),
    description: description.nullable().optional(),
  })
  .strict();
export const assetUploadBody = z
  .object({
    version,
    // 255 is the column width; the segment regex alone would admit 519 chars,
    // which the repository could only answer with a 503.
    path: z
      .string()
      .max(200)
      .regex(RELATIVE_PATH, "relative path (max 8 segments)"),
    // The hard ceiling; the effective per-bundle value is checked in the route.
    size: z.number().int().positive().max(LIMITS["asset.fileBytes"].hard),
  })
  .strict();

export function assetStagingKey(uploadId: string, path: string): string {
  return `${ASSET_UPLOAD_KEY_PREFIX}${uploadId}/${path}`;
}

/**
 * `assets/{bundleId}/{version}/{path}`: id-based since 2026-08-26, so a bundle
 * can be renamed while it holds files. Rows committed before that keep their
 * `assets/{name}/…` keys, which is why reference checks derive prefixes from
 * the stored `object_key`s rather than from the current name.
 */
export function assetObjectKey(
  bundle: Pick<AssetBundleRow, "id">,
  v: string,
  path: string,
): string {
  return `${ASSET_KEY_PREFIX}${bundle.id}/${v}/${path}`;
}

/** `assets/{x}/{version}/` for each distinct `{x}` the files were stored under. */
export function versionPrefixes(files: Pick<AssetFileRow, "objectKey">[]) {
  const out = new Set<string>();
  for (const f of files) {
    const parts = f.objectKey.split("/");
    if (parts.length >= 3) out.add(`${parts[0]}/${parts[1]}/${parts[2]}/`);
  }
  return [...out];
}

/** `assets/{x}/` for each distinct `{x}` the files were stored under. */
export function bundlePrefixes(files: Pick<AssetFileRow, "objectKey">[]) {
  const out = new Set<string>();
  for (const f of files) {
    const parts = f.objectKey.split("/");
    if (parts.length >= 2) out.add(`${parts[0]}/${parts[1]}/`);
  }
  return [...out];
}

export interface AssetRoutesOptions {
  db: ConsoleDb;
  assets: AssetsDb;
  limits: Pick<LimitsDb, "listOverrides">;
  team: TeamDb;
  access: Pick<
    TeamAccessHelpers,
    "projectAccess" | "projectResource" | "memberTeamIds"
  >;
  crumbs: CrumbResolver;
  history: ResourceHistory;
  /** `undefined` = artifact storage not configured (upload routes answer 503). */
  artifacts?: ArtifactStore;
  /** `https://dev-d.yyt.life` — public CDN in front of the artifact bucket. */
  cdnBaseUrl: string;
  clock: Clock;
  logger: Logger;
  audit: (
    actorId: string | null,
    action: string,
    target: string | null,
    detail?: unknown,
  ) => Promise<void>;
}

export function createAssetRoutes({
  db,
  assets,
  limits,
  team,
  access,
  crumbs,
  history,
  artifacts,
  cdnBaseUrl,
  clock,
  logger,
  audit,
}: AssetRoutesOptions): AnyRoute[] {
  const { projectAccess, projectResource, memberTeamIds } = access;

  function requireStore(): ArtifactStore {
    if (!artifacts)
      throw new AppError("unavailable", "artifact storage is not configured");
    return artifacts;
  }

  /**
   * Asset **content** is public (the CDN serves it unauthenticated, which is
   * the point — a game client holds no GitHub account). The management API is
   * not: every member of the bundle's team reads and writes it; a platform
   * admin without a membership may read (`docs/decisions.md` *Teams
   * and projects*).
   */
  async function bundleWith(
    ctx: RouteContext,
    write: boolean,
  ): Promise<ResourceAccess<"bundle">> {
    return projectResource(
      ctx,
      { kind: "bundle", id: ctx.params.bundle! },
      write ? { secret: true } : {},
    );
  }

  /** 404 rather than 403: an upload id must not be distinguishable from one that never existed. */
  async function uploadWith(
    ctx: RouteContext,
  ): Promise<ResourceAccess<"bundle"> & { upload: AssetUploadRow }> {
    const upload = await assets.findUpload(ctx.params.id!);
    if (!upload) throw new AppError("not_found", "upload not found");
    const a = await asUploadOwner(() =>
      projectResource(
        ctx,
        { kind: "bundle", id: upload.bundleId },
        { secret: true },
      ),
    );
    return { ...a, upload };
  }

  /** Names are unique within the team across every kind (`docs/decisions.md`). */
  async function requireFreeName(
    teamId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const hit = await assets.findBundleByName(teamId, name);
    if (hit && hit.id !== exceptId)
      throw new AppError(
        "conflict",
        `a bundle named "${name}" already exists in this team`,
      );
  }

  const bundleHistory = (
    b: AssetBundleRow,
    actorId: string,
    action: "resource.create" | "resource.update" | "resource.delete",
    fields?: string[],
  ) =>
    history(
      b.teamId,
      actorId,
      action,
      b.id,
      {
        resource: { kind: "bundle", id: b.id, name: b.name },
        ...(fields ? { fields } : {}),
      },
      nowSec(clock),
    );

  async function bundleViews(rows: AssetBundleRow[]) {
    const crumb = await crumbs(rows);
    return rows.map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description,
      ...crumb(b),
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    }));
  }
  const bundleView = async (b: AssetBundleRow) => (await bundleViews([b]))[0]!;

  const fileView = (f: AssetFileRow) => ({
    id: f.id,
    bundleId: f.bundleId,
    version: f.version,
    path: f.path,
    url: f.url,
    objectKey: f.objectKey,
    contentType: f.contentType,
    size: f.size,
    hash: f.hash,
    createdAt: f.createdAt,
  });

  const uploadView = (u: AssetUploadRow) => ({
    id: u.id,
    bundleId: u.bundleId,
    version: u.version,
    path: u.path,
    contentType: u.contentType,
    size: u.size,
    status: u.status,
    fileId: u.fileId,
    createdAt: u.createdAt,
    expiresAt: u.expiresAt,
  });

  /** `{version, files, bytes, createdAt}` per version, newest first. */
  const versionsOf = (summaries: AssetVersionSummary[]) =>
    summaries
      .map(({ version, files, bytes, createdAt }) => ({
        version,
        files,
        bytes,
        createdAt,
      }))
      .sort(
        (a, b) =>
          b.createdAt - a.createdAt || b.version.localeCompare(a.version),
      );

  /**
   * Every quota a new file must fit, against committed rows (aggregates) plus
   * every presign still in flight: a grant is a reservation, and counting
   * only committed rows would let a caller pipeline a hundred grants past the
   * cap, each one seeing an empty bundle. A commit passes its own upload as
   * `except`, since its reservation is the file it is about to write. A
   * presign refuses with 400, a commit (whose grant saw an older state, or a
   * limit lowered since) with 409.
   */
  async function checkQuota(
    bundle: AssetBundleRow,
    file: { version: string; size: number },
    now: number,
    status: "bad_request" | "conflict",
    o: { except?: string; inFlight?: AssetUploadRow[] } = {},
  ): Promise<void> {
    const { except } = o;
    const scopes: LimitScope[] = [{ kind: "bundle", id: bundle.id }];
    if (bundle.projectId)
      scopes.push({ kind: "project", id: bundle.projectId });
    const limit = await resolveLimits(limits, scopes, now);
    const over = (key: LimitKey, message: (max: string) => string) => {
      const max = limit(key);
      return overLimit(status, key, max, message(formatLimitValue(key, max)));
    };
    const fileMax = limit("asset.fileBytes");
    if (file.size > fileMax)
      throw over(
        "asset.fileBytes",
        (m) => `a file in this bundle holds at most ${m}`,
      );
    const summaries = await assets.versionSummaries(bundle.id);
    const inFlight = (
      o.inFlight ?? (await assets.listInFlightUploads(bundle.id, now))
    ).filter((u) => u.id !== except);
    const inVersion =
      (summaries.find((v) => v.version === file.version)?.files ?? 0) +
      inFlight.filter((u) => u.version === file.version).length;
    if (inVersion + 1 > limit("asset.filesPerVersion"))
      throw over(
        "asset.filesPerVersion",
        (m) => `a version holds at most ${m} files`,
      );
    const versions = new Set([
      ...summaries.map((v) => v.version),
      ...inFlight.map((u) => u.version),
    ]);
    if (
      !versions.has(file.version) &&
      versions.size + 1 > limit("asset.versionsPerBundle")
    )
      throw over(
        "asset.versionsPerBundle",
        (m) => `a bundle holds at most ${m} versions`,
      );
    const files = summaries.reduce((n, v) => n + v.files, 0) + inFlight.length;
    if (files + 1 > limit("asset.filesPerBundle"))
      throw over(
        "asset.filesPerBundle",
        (m) => `a bundle holds at most ${m} files`,
      );
    const bytes =
      summaries.reduce((n, v) => n + v.bytes, 0) +
      inFlight.reduce((n, u) => n + u.size, 0);
    if (bytes + file.size > limit("asset.bundleBytes"))
      throw over("asset.bundleBytes", (m) => `bundle would exceed ${m}`);
    if (bundle.projectId) {
      const p = await assets.projectAssetUsage(bundle.projectId, now, except);
      if (p.bytes + p.inFlightBytes + file.size > limit("asset.projectBytes"))
        throw over(
          "asset.projectBytes",
          (m) => `project assets would exceed ${m}`,
        );
    }
  }

  /**
   * Deletes each object, then only the rows whose object actually went. A
   * swallowed failure would strand a public `immutable` object that nothing can
   * ever reclaim — `assets/` is deliberately outside every sweep — so a failed
   * delete keeps its row and the caller is told to retry, the same discipline
   * `runCatalogSweep` uses.
   */
  async function deleteFiles(
    store: ArtifactStore,
    files: AssetFileRow[],
  ): Promise<void> {
    let failed = 0;
    for (const f of files) {
      try {
        await store.delete(f.objectKey);
      } catch (e) {
        failed++;
        logger.warn("asset object delete failed", {
          key: f.objectKey,
          message: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      await assets.deleteFile(f.id);
    }
    if (failed > 0)
      throw new AppError(
        "unavailable",
        `${failed} object(s) could not be deleted; retry`,
      );
  }

  /**
   * Lobby channels whose `mapUrl` points inside any of `prefixes`. Deleting
   * what a channel still serves is not a degraded game but one that cannot
   * load at all, and the URL is cached `immutable`, so this is checked before
   * the delete rather than repaired after it. The scan is **global** — the
   * CDN is public, so another team pointing at these files is legitimate —
   * but the ids named in the 409 are only those the caller can see.
   */
  async function referencingChannels(
    prefixes: string[],
    visibleTeamId: string | null,
  ): Promise<{ count: number; visible: string[] }> {
    // `artifactUrl` trims the trailing slash; put it back so `maps` does not
    // match `maps2` and version `1.0` does not match `1.0.1`.
    const urls = prefixes.map((p) => `${artifactUrl(cdnBaseUrl, p)}/`);
    const rows = await db.listChannels({ kind: "lobby" });
    let count = 0;
    const visible: string[] = [];
    for (const row of rows) {
      let mapUrl: unknown;
      try {
        mapUrl = (JSON.parse(row.configJson) as { mapUrl?: unknown }).mapUrl;
      } catch {
        continue; // unparseable config cannot be pointing anywhere
      }
      if (typeof mapUrl !== "string" || !urls.some((u) => mapUrl.startsWith(u)))
        continue;
      count++;
      if (row.teamId !== null && row.teamId === visibleTeamId)
        visible.push(row.id);
    }
    return { count, visible };
  }

  function assertUnreferenced(
    refs: { count: number; visible: string[] },
    what: string,
  ): void {
    if (refs.count === 0) return;
    throw new AppError(
      "conflict",
      `${what} is still the map of ${refs.count} lobby channel(s); re-point them first`,
      { details: { channels: refs.visible } },
    );
  }

  return [
    {
      method: "GET",
      path: "/assets/bundles",
      auth: true,
      handler: async (ctx) => {
        // Every bundle of every team the caller is seated in, flattened.
        const id = requireRole(ctx, "member");
        const teamIds = await memberTeamIds(id);
        if (teamIds.length === 0) return { bundles: [] };
        return {
          bundles: await bundleViews(await assets.listBundles({ teamIds })),
        };
      },
    },
    defineRoute({
      method: "GET",
      path: "/projects/{prj}/assets/bundles",
      auth: true,
      query: bundlesQuery,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!);
        return {
          bundles: await bundleViews(
            await assets.listBundles({
              ...listParams(ctx.query),
              projectId: a.project.id,
            }),
          ),
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/projects/{prj}/assets/bundles",
      auth: true,
      body: bundleCreateBody,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!, { secret: true });
        const now = nowSec(clock);
        const limit = await resolveLimits(
          limits,
          [{ kind: "project", id: a.project.id }],
          now,
        );
        const max = limit("asset.bundlesPerProject");
        // Bounded by the hard value (50), so the list is small.
        if (
          (await assets.listBundles({ projectId: a.project.id })).length >= max
        )
          throw overLimit(
            "conflict",
            "asset.bundlesPerProject",
            max,
            `too many asset bundles (max ${max} per project)`,
          );
        await requireFreeName(a.team.id, ctx.body.name);
        const bundleId = `ab_${randomHex(8)}`;
        await assets.insertBundle({
          id: bundleId,
          name: ctx.body.name,
          description: ctx.body.description ?? null,
          ownerId: a.id.subject,
          teamId: a.team.id,
          projectId: a.project.id,
          createdAt: now,
        });
        await audit(a.id.subject, "asset.bundle.create", bundleId, {
          name: ctx.body.name,
          projectId: a.project.id,
        });
        const b = await assets.findBundle(bundleId);
        if (!b) throw new AppError("unavailable", "bundle vanished");
        await bundleHistory(b, a.id.subject, "resource.create");
        return {
          statusCode: 201,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(await bundleView(b)),
        };
      },
    }),
    {
      method: "GET",
      path: "/assets/bundles/{bundle}",
      auth: true,
      handler: async (ctx) => {
        const { row: bundle } = await bundleWith(ctx, false);
        const summaries = await assets.versionSummaries(bundle.id);
        return {
          ...(await bundleView(bundle)),
          versions: versionsOf(summaries),
          files: summaries.reduce((n, v) => n + v.files, 0),
          bytes: summaries.reduce((n, v) => n + v.bytes, 0),
        };
      },
    },
    defineRoute({
      method: "PATCH",
      path: "/assets/bundles/{bundle}",
      auth: true,
      body: bundlePatchBody,
      handler: async (ctx) => {
        const { id, row: bundle, team: o } = await bundleWith(ctx, true);
        const patch: { name?: string; description?: string | null } = {};
        // Renaming is fine even with files: keys are id-based now, and rows
        // from before that keep the `url` they were committed with.
        if (ctx.body.name !== undefined && ctx.body.name !== bundle.name) {
          await requireFreeName(o.id, ctx.body.name, bundle.id);
          patch.name = ctx.body.name;
        }
        if (ctx.body.description !== undefined)
          patch.description = ctx.body.description;
        const ok = await assets.updateBundle(bundle.id, patch, nowSec(clock));
        if (!ok) throw new AppError("not_found", "asset bundle not found");
        await audit(id.subject, "asset.bundle.update", bundle.id, {
          fields: Object.keys(patch),
        });
        await bundleHistory(
          bundle,
          id.subject,
          "resource.update",
          Object.keys(patch),
        );
        const b = await assets.findBundle(bundle.id);
        if (!b) throw new AppError("not_found", "asset bundle not found");
        return bundleView(b);
      },
    }),
    {
      method: "DELETE",
      path: "/assets/bundles/{bundle}",
      auth: true,
      handler: async (ctx) => {
        const { id, row: bundle } = await bundleWith(ctx, true);
        const files = await assets.listFiles(bundle.id);
        assertUnreferenced(
          await referencingChannels(bundlePrefixes(files), bundle.teamId),
          `bundle "${bundle.name}"`,
        );
        // An empty bundle is just a row: it must stay deletable even when no
        // artifact bucket is configured.
        if (files.length > 0) await deleteFiles(requireStore(), files);
        await assets.deleteBundle(bundle.id);
        await audit(id.subject, "asset.bundle.delete", bundle.id, {
          name: bundle.name,
        });
        await bundleHistory(bundle, id.subject, "resource.delete");
        return undefined;
      },
    },
    defineRoute({
      method: "GET",
      path: "/assets/bundles/{bundle}/versions/{version}",
      auth: true,
      query: filePageQuery,
      handler: async (ctx) => {
        const { row: bundle } = await bundleWith(ctx, false);
        const version = ctx.params.version!;
        const page = await assets.listFilesPage(bundle.id, version, {
          after: ctx.query.cursor,
          limit: ctx.query.limit,
        });
        if (
          page.rows.length === 0 &&
          !(await assets.hasVersion(bundle.id, version))
        )
          throw new AppError("not_found", "version not found");
        return {
          bundle: bundle.name,
          bundleId: bundle.id,
          // Version and path are `utf8mb4_bin`, so the stored spelling is the
          // caller's: these are S3 key segments.
          version,
          files: page.rows.map(fileView),
          next: page.next,
        };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/assets/bundles/{bundle}/files",
      auth: true,
      query: filePageQuery.extend({ version }),
      handler: async (ctx) => {
        const { row: bundle } = await bundleWith(ctx, false);
        const page = await assets.listFilesPage(bundle.id, ctx.query.version, {
          after: ctx.query.cursor,
          limit: ctx.query.limit,
        });
        return {
          bundleId: bundle.id,
          version: ctx.query.version,
          files: page.rows.map(fileView),
          next: page.next,
        };
      },
    }),
    {
      method: "DELETE",
      path: "/assets/bundles/{bundle}/versions/{version}",
      auth: true,
      handler: async (ctx) => {
        const { id, row: bundle } = await bundleWith(ctx, true);
        const store = requireStore();
        const files = await assets.listFiles(bundle.id, {
          version: ctx.params.version!,
        });
        if (files.length === 0)
          throw new AppError("not_found", "version not found");
        assertUnreferenced(
          await referencingChannels(versionPrefixes(files), bundle.teamId),
          `version "${ctx.params.version!}"`,
        );
        await deleteFiles(store, files);
        // A project version pointing at this asset version now dangles; the
        // link table only cascades on the bundle, so drop those rows here.
        await team.removeAssetVersionLinks(bundle.id, files[0]!.version);
        await audit(id.subject, "asset.version.delete", bundle.id, {
          version: ctx.params.version!,
          files: files.length,
        });
        await bundleHistory(bundle, id.subject, "resource.update", [
          `version:${files[0]!.version}:delete`,
        ]);
        return undefined;
      },
    },
    defineRoute({
      method: "POST",
      path: "/assets/bundles/{bundle}/files",
      auth: true,
      body: assetUploadBody,
      handler: async (ctx) => {
        const { id, row: bundle } = await bundleWith(ctx, true);
        const store = requireStore();
        const contentType = assetContentType(ctx.body.path);
        const now = nowSec(clock);
        // Write-once: the object is `immutable`, so a second upload to the same
        // (version, path) could never reach a client that already cached it.
        // A presign in flight holds the path too.
        const inFlight = await assets.listInFlightUploads(bundle.id, now);
        if (
          inFlight.some(
            (u) => u.version === ctx.body.version && u.path === ctx.body.path,
          ) ||
          (await assets.findFileByPath(
            bundle.id,
            ctx.body.version,
            ctx.body.path,
          ))
        )
          throw new AppError(
            "conflict",
            "this path already exists in this version; publish a new version",
          );
        await checkQuota(
          bundle,
          { version: ctx.body.version, size: ctx.body.size },
          now,
          "bad_request",
          { inFlight },
        );
        const uploadId = randomHex(16);
        await assets.insertUpload({
          id: uploadId,
          bundleId: bundle.id,
          version: ctx.body.version,
          path: ctx.body.path,
          contentType,
          size: ctx.body.size,
          createdAt: now,
          expiresAt: now + ARTIFACT_UPLOAD_URL_TTL_SEC,
        });
        const key = assetStagingKey(uploadId, ctx.body.path);
        const url = await store.presignPut({
          key,
          contentLength: ctx.body.size,
          contentType,
        });
        await audit(id.subject, "asset.file.upload", bundle.id, {
          uploadId,
          version: ctx.body.version,
          path: ctx.body.path,
        });
        return uploadGrant({
          uploadId,
          key,
          url,
          contentType,
          size: ctx.body.size,
          expiresAt: now + ARTIFACT_UPLOAD_URL_TTL_SEC,
        });
      },
    }),
    {
      method: "GET",
      path: "/assets/uploads/{id}",
      auth: true,
      handler: async (ctx) => uploadView((await uploadWith(ctx)).upload),
    },
    {
      method: "POST",
      path: "/assets/uploads/{id}/commit",
      auth: true,
      handler: async (ctx) => {
        const { id, upload, row: bundle } = await uploadWith(ctx);
        const store = requireStore();
        // Idempotent: a duplicate commit returns the existing file.
        if (upload.status === "completed" && upload.fileId) {
          const existing = await assets.findFile(upload.fileId);
          if (existing) return fileView(existing);
        }
        if (upload.status !== "pending")
          throw new AppError("conflict", `upload is ${upload.status}`);
        const now = nowSec(clock);
        if (now > upload.expiresAt)
          throw new AppError("conflict", "upload expired");
        const stagingKey = assetStagingKey(upload.id, upload.path);
        const obj = await store.head(stagingKey);
        if (!obj) throw new AppError("bad_request", "file was not uploaded");
        // The presign signed the length; any other size is not this grant's.
        if (obj.contentLength !== upload.size)
          throw new AppError("bad_request", "uploaded file has a bad size");
        const finalKey = assetObjectKey(bundle, upload.version, upload.path);
        const url = artifactUrl(cdnBaseUrl, finalKey);
        // The full upload id, not a prefix of it: `asset_files.id` is a global
        // primary key, and an 8-hex-char slice collides often enough that a
        // legitimate commit could heal onto an unrelated file's row.
        const fileId = `af_${upload.id}`;
        // Re-check every quota against everything that has landed since the
        // presign: the grant only ever saw the state of its own moment, and a
        // limit may have been lowered since. Not when resuming our own claim:
        // that row already passed, and counting it beside its own reservation
        // would refuse the retry at an exact cap for good.
        const resumed = (await assets.findFile(fileId))?.objectKey === finalKey;
        if (!resumed)
          await checkQuota(
            bundle,
            { version: upload.version, size: obj.contentLength },
            now,
            "conflict",
            { except: upload.id },
          );
        // The ROW IS THE CLAIM, taken before the object is written. Copying
        // first would let a second upload of the same (version, path) overwrite
        // a live `immutable` object before discovering it lost the race, and
        // would strand its copy under `assets/` — which nothing sweeps.
        try {
          await assets.insertFile({
            id: fileId,
            bundleId: bundle.id,
            version: upload.version,
            path: upload.path,
            objectKey: finalKey,
            url,
            contentType: upload.contentType,
            size: obj.contentLength,
            hash: obj.etag,
            createdAt: now,
          });
        } catch (e) {
          const existing = await assets.findFile(fileId);
          // Our own earlier attempt (same upload) that died before finishing:
          // resume it. Anything else already owns this path.
          if (!existing || existing.objectKey !== finalKey) {
            await assets.updateUpload(upload.id, { status: "failed" });
            throw new AppError(
              "conflict",
              "this path already exists in this version; publish a new version",
              { cause: e instanceof Error ? e : undefined },
            );
          }
        }
        try {
          // MetadataDirective REPLACE: the staging object carries the signed
          // type but no cache policy, and the committed object is immutable.
          await store.copy(stagingKey, finalKey, {
            contentType: upload.contentType,
            cacheControl: ASSET_CACHE_CONTROL,
          });
        } catch (e) {
          // The claim now names an object that does not exist; drop it so the
          // path is free again instead of serving a 404 to every client, and
          // release the reservation too — otherwise the retry this error asks
          // for is refused by the caller's own dead grant for the next hour.
          await assets.deleteFile(fileId).catch(() => undefined);
          await assets
            .updateUpload(upload.id, { status: "failed" })
            .catch(() => undefined);
          throw new AppError("unavailable", "artifact storage error", {
            cause: e,
          });
        }
        await assets.updateUpload(upload.id, {
          status: "completed",
          objectKey: finalKey,
          etag: obj.etag,
          fileId,
        });
        await store.delete(stagingKey).catch(() => undefined);
        await audit(id.subject, "asset.file.commit", fileId, {
          bundleId: bundle.id,
          version: upload.version,
          path: upload.path,
        });
        const f = await assets.findFile(fileId);
        if (!f) throw new AppError("unavailable", "asset file vanished");
        return fileView(f);
      },
    },
  ];
}
