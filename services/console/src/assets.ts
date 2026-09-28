import {
  ASSET_TOMBSTONE_SEC,
  BUNDLE_SORT_KEYS,
  LIVE_VERSION,
} from "@yyt/console-db";
import {
  AppError,
  nowMs,
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
import {
  defineRoute,
  json,
  type AnyRoute,
  type HttpResult,
  type RouteContext,
} from "@yyt/http";
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
  DELETE_OBJECTS_MAX,
  grantBody,
  MULTIPART_UPLOAD_TTL_SEC,
  MultipartGoneError,
  type ArtifactStore,
  uploadGrant,
} from "./artifact-store.js";
import {
  ASSET_CACHE_CONTROL,
  assetObjectKey,
  assetStagingKey,
  createAssetCommitter,
  MULTIPART_PART_BYTES,
  MULTIPART_THRESHOLD_BYTES,
  multipartPartCount,
  multipartPartSize,
  tombstoned,
  type AssetCommitter,
} from "./asset-commit.js";
import { sha256Base64 } from "./s3-util.js";
import {
  ASSET_ENC_FORMAT,
  ASSET_ENC_MIN_BYTES,
  assetEncryptionNotConfigured,
  assetPlaintextLength,
  isAssetCiphertextLength,
  type AssetKeyring,
} from "./asset-crypto.js";
import { artifactUrl } from "./catalog.js";
import { requireRole, type ConsoleIdentity } from "./identity.js";
import type { TeamAccessHelpers, ResourceAccess } from "./team-access.js";
import { resourceName } from "./team.js";
import {
  type CrumbResolver,
  type ResourceHistory,
  asUploadOwner,
} from "./resources.js";

export {
  ASSET_CACHE_CONTROL,
  ASSET_KEY_PREFIX,
  ASSET_MUTABLE_CACHE_CONTROL,
  ASSET_UPLOAD_KEY_PREFIX,
  assetObjectKey,
  assetStagingKey,
} from "./asset-commit.js";
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
 * (`rules/security.md`). The binary types render nowhere and neither
 * distribution compresses them, so byte ranges stay the stored object's.
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
  ".db": "application/octet-stream",
  ".sqlite": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".zip": "application/zip",
};
/** A mutable file is a manifest: JSON or text (decisions #1). */
export const MUTABLE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  ASSET_CONTENT_TYPES[".json"]!,
  ASSET_CONTENT_TYPES[".txt"]!,
]);
/** Files per presign or commit call (the show-screenshot precedent). */
export const ASSET_BATCH_MAX = 100;
/** Paths per delete or stale call; the 64 KiB body bounds it further. */
export const ASSET_PATHS_MAX = DELETE_OBJECTS_MAX;
/** Commits a batch runs at once (S3 round trips overlap; the pool is one connection). */
export const ASSET_COMMIT_CONCURRENCY = 8;
/**
 * How long a batch commit starts new commits: the rest answer "commit it
 * again" and stay pending.
 */
export const ASSET_COMMIT_BUDGET_MS = 15_000;
/**
 * How long a bundle or version delete keeps deleting before it answers 202
 * with its progress: the API function has 25 s, and each round is one
 * `DeleteObjects` of up to 1,000 keys plus one statement.
 */
export const ASSET_DELETE_BUDGET_MS = 15_000;

/** The part checksums a multipart uploader asks URLs for (`POST …/parts`). */
const partsBody = z
  .object({
    parts: z
      .array(
        z
          .object({
            partNumber: z.number().int().min(1).max(64),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
  })
  .strict();

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
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "lowercase hex SHA-256");

/**
 * A relative path inside the bundle: segments separated by `/`, no `.`/`..`,
 * no leading slash, no backslash. `..` would escape the version prefix and let
 * one bundle write over another's live objects.
 */
const RELATIVE_PATH =
  /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,63}(\/[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,63}){0,7}$/;
// 255 is the column width; the segment regex alone would admit 519 chars,
// which the repository could only answer with a 503.
const relativePath = z
  .string()
  .max(200)
  .regex(RELATIVE_PATH, "relative path (max 8 segments)");

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
  .object({
    name: bundleName,
    description: description.optional(),
    mode: z.enum(["versioned", "live"]).optional(),
    /** Every object is `yyt-enc v1` ciphertext; fixed at creation (decisions #4). */
    encrypted: z.boolean().optional(),
  })
  .strict();
export const bundlePatchBody = z
  .object({
    name: bundleName.optional(),
    description: description.nullable().optional(),
  })
  .strict();
const fileSpec = z
  .object({
    path: relativePath,
    // The hard ceiling; the effective per-bundle value is checked in the route.
    size: z.number().int().positive().max(LIMITS["asset.fileBytes"].hard),
    sha256: sha256.optional(),
    mutable: z.boolean().optional(),
    ifSha256: sha256.optional(),
  })
  .strict();
/**
 * Required on an encrypted bundle, refused on a plain one: an uploader that
 * does not know the format (an older CLI, the SPA) cannot put plaintext into
 * an encrypted bundle by accident.
 */
const format = z.literal(ASSET_ENC_FORMAT).optional();
/** One file: `version` for a versioned bundle, none for a live one. */
export const assetUploadBody = fileSpec
  .extend({ version: version.optional(), format })
  .strict();
export const assetUploadBatchBody = z
  .object({
    version: version.optional(),
    format,
    files: z.array(fileSpec).min(1).max(ASSET_BATCH_MAX),
  })
  .strict();
/**
 * The presign body is one file or `{files}`: picked by shape before it is
 * validated, so an error names the field (a plain union reports only
 * "invalid input").
 */
const presignBody = z
  .unknown()
  .transform(
    (
      b,
      ctx,
    ):
      | z.infer<typeof assetUploadBatchBody>
      | z.infer<typeof assetUploadBody> => {
      const schema =
        b !== null && typeof b === "object" && "files" in b
          ? assetUploadBatchBody
          : assetUploadBody;
      const r = schema.safeParse(b);
      if (r.success) return r.data;
      for (const i of r.error.issues)
        ctx.addIssue({ code: "custom", message: i.message, path: i.path });
      return z.NEVER;
    },
  );
const assetCommitBatchBody = z
  .object({ ids: z.array(z.string().max(64)).min(1).max(ASSET_BATCH_MAX) })
  .strict();
const pathList = z.array(relativePath).max(ASSET_PATHS_MAX);
const fileDeleteBody = z
  .object({
    paths: pathList.min(1),
    /** Only files a sync already marked stale (`--prune`). */
    stale: z.boolean().optional(),
  })
  .strict();
const fileMarkBody = z
  .object({ stale: pathList.optional(), fresh: pathList.optional() })
  .strict()
  .refine(
    (b) => (b.stale?.length ?? 0) + (b.fresh?.length ?? 0) <= ASSET_PATHS_MAX,
    `at most ${ASSET_PATHS_MAX} paths per call`,
  );

/**
 * The file a lobby `mapUrl` names: a committed file of a versioned bundle of
 * the channel's own team, found through its stored object key
 * (docs/decisions.md *Live and encrypted asset bundles* #2). The origin was
 * already pinned to the CDN; this pins the path. Returns the file's own URL,
 * which the channel stores instead of the caller's spelling: `%5F` for `_`,
 * a doubled slash or a query would otherwise name the same object in a form
 * the delete guard's prefix match never sees.
 */
export async function requireMapFile(
  assets: Pick<AssetsDb, "findFileByObjectKey" | "findBundle" | "findUpload">,
  teamId: string,
  mapUrl: string,
): Promise<string> {
  const refuse = (why: string) => new AppError("bad_request", `mapUrl: ${why}`);
  let key: string;
  try {
    key = new URL(mapUrl).pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent)
      .join("/");
  } catch {
    throw refuse("not a file URL");
  }
  const file = await assets.findFileByObjectKey(key);
  const bundle = file && (await assets.findBundle(file.bundleId));
  if (!file || !bundle || bundle.teamId !== teamId)
    throw refuse("must name a committed file of one of this team's bundles");
  if (bundle.mode !== "versioned")
    throw refuse(
      "a live bundle can change under a running game; use a versioned bundle",
    );
  if (bundle.encrypted)
    throw refuse("an encrypted bundle holds ciphertext, which is not a map");
  // A row is inserted before its object is copied (the claim): until its
  // upload completes, the row may name an object that never lands.
  if (file.id.startsWith("af_")) {
    const u = await assets.findUpload(file.id.slice(3));
    if (u && u.status !== "completed")
      throw refuse("that file is still being committed");
  }
  return file.url;
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
  /** `undefined` = no usable `ASSET_KEK` on this stage (encrypted routes answer 503). */
  keyring?: AssetKeyring;
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
  /**
   * The per-member recorded-write slot (`write-slot.ts`): a file delete
   * writes an audit row and a team-history row per call.
   */
  writeSlot: (id: ConsoleIdentity) => Promise<void>;
  /** Test hook: how long a bundle or version delete runs per request. */
  deleteBudgetMs?: number;
  /** Test hook: how long a batch commit starts new commits. */
  commitBudgetMs?: number;
  /** Test hook: the pause between `ConditionalRequestConflict` retries. */
  sleep?: (ms: number) => Promise<void>;
}

/** One quota item: a file a presign reserves or a commit writes. */
export interface QuotaItem {
  version: string;
  size: number;
  /** A new path (a mutable replacement adds no file). */
  newFile: boolean;
  /** Bytes of the file a mutable replacement overwrites. */
  replaces?: number;
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
  keyring,
  cdnBaseUrl,
  clock,
  logger,
  audit,
  writeSlot,
  deleteBudgetMs = ASSET_DELETE_BUDGET_MS,
  commitBudgetMs = ASSET_COMMIT_BUDGET_MS,
  sleep,
}: AssetRoutesOptions): AnyRoute[] {
  const { projectAccess, projectResource, memberTeamIds } = access;

  function requireStore(): ArtifactStore {
    if (!artifacts)
      throw new AppError("unavailable", "artifact storage is not configured");
    return artifacts;
  }

  function requireKeyring(): AssetKeyring {
    if (!keyring) throw assetEncryptionNotConfigured();
    return keyring;
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
      mode: b.mode,
      encrypted: b.encrypted,
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
    sha256: f.sha256,
    mutable: f.mutable,
    staleSince: f.staleSince,
    createdAt: f.createdAt,
  });

  const uploadView = (u: AssetUploadRow) => ({
    id: u.id,
    bundleId: u.bundleId,
    version: u.version,
    path: u.path,
    contentType: u.contentType,
    size: u.size,
    sha256: u.sha256,
    mutable: u.mutable,
    status: u.status,
    fileId: u.fileId,
    multipart: u.s3UploadId !== null,
    partSize: u.partSize,
    partCount: u.partCount,
    createdAt: u.createdAt,
    expiresAt: u.expiresAt,
  });

  /**
   * The 201 body of a file over the single-PUT ceiling: no URL yet — the
   * uploader asks `POST /assets/uploads/{id}/parts` for its part URLs, with
   * each part's SHA-256 (docs/decisions.md *Large asset uploads* #1).
   */
  const multipartGrant = (o: {
    uploadId: string;
    key: string;
    size: number;
    sha256: string;
    contentType: string;
    expiresAt: number;
  }) => ({
    uploadId: o.uploadId,
    key: o.key,
    multipart: true as const,
    partSize: MULTIPART_PART_BYTES,
    partCount: multipartPartCount(o.size),
    size: o.size,
    sha256: o.sha256,
    contentType: o.contentType,
    expiresAt: o.expiresAt,
  });

  /**
   * Aborts a bundle's (or one version's) multipart uploads S3 may still hold
   * before their rows go: a dropped row leaves invisible, billed parts until
   * the lifecycle rule's day, and a completion after the delete would
   * publish an object no row names.
   */
  async function abortOpenUploads(
    bundle: AssetBundleRow,
    version?: string,
  ): Promise<number> {
    const open = (await assets.listOpenMultipartUploads(bundle.id)).filter(
      (u) => version === undefined || u.version === version,
    );
    if (open.length === 0) return 0;
    const store = requireStore();
    for (const u of open) {
      const key = assetObjectKey(bundle, u.version, u.path);
      const r = await store.abortMultipart(key, u.s3UploadId!);
      // The claim rule holds here too (decisions #2): the file row is never
      // dropped on the upload's word alone. An upload already gone may have
      // completed; then the row stays and the delete that follows takes the
      // object with every other file. A claim whose object is absent leaves
      // its row to `deleteAll`, where a missing key counts as deleted.
      if (r === "gone" && (await store.inspect(key)).state !== "absent") {
        await assets.updateUpload(u.id, { status: "completed" });
        continue;
      }
      await assets.deleteUpload(u.id);
    }
    return open.length;
  }

  /**
   * A file row whose `af_` upload has not completed is a claim, not a file:
   * the object may not exist yet. A presign of the same bytes must not call
   * it present — the commit is what makes it one — so it names the upload
   * for the caller to commit again (decisions *Large asset uploads* #2).
   */
  async function requireCommitted(ex: AssetFileRow): Promise<void> {
    if (!ex.id.startsWith("af_")) return;
    const u = await assets.findUpload(ex.id.slice(3));
    if (!u || u.status === "completed") return;
    throw new AppError(
      "conflict",
      `"${ex.path}" is being committed; commit that upload again`,
      { details: { path: ex.path, reason: "committing", uploadId: u.id } },
    );
  }

  /** `{version, files, bytes, createdAt}` per version, newest first. */
  const versionsOf = (summaries: AssetVersionSummary[]) =>
    summaries
      .filter((v) => v.version !== LIVE_VERSION)
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

  async function limitsOf(bundle: AssetBundleRow, now: number) {
    const scopes: LimitScope[] = [{ kind: "bundle", id: bundle.id }];
    if (bundle.projectId)
      scopes.push({ kind: "project", id: bundle.projectId });
    const limit = await resolveLimits(limits, scopes, now);
    return {
      limit,
      over: (
        status: "bad_request" | "conflict",
        key: LimitKey,
        message: (max: string) => string,
      ) => {
        const max = limit(key);
        return overLimit(status, key, max, message(formatLimitValue(key, max)));
      },
    };
  }

  /**
   * Every quota the new files must fit, against committed rows (aggregates)
   * plus every presign still in flight: a grant is a reservation, and
   * counting only committed rows would let a caller pipeline a hundred grants
   * past the cap, each one seeing an empty bundle. A commit passes its own
   * upload ids as `except`, since those reservations are the files it is
   * about to write. A presign refuses with 400, a commit (whose grant saw an
   * older state, or a limit lowered since) with 409.
   */
  async function checkQuota(
    bundle: AssetBundleRow,
    items: readonly QuotaItem[],
    now: number,
    status: "bad_request" | "conflict",
    o: {
      except?: readonly string[];
      inFlight?: AssetUploadRow[];
      /** The bundle's limits, when the caller already resolved them. */
      lim?: Awaited<ReturnType<typeof limitsOf>>;
    } = {},
  ): Promise<void> {
    if (items.length === 0) return;
    const except = new Set(o.except ?? []);
    const { limit, over } = o.lim ?? (await limitsOf(bundle, now));
    // The per-file ceiling is a plaintext ceiling: an encrypted file's
    // 0.05 % of overhead does not count against it (the totals below do
    // count what is stored).
    const plainSize = (n: number) =>
      bundle.encrypted ? assetPlaintextLength(n) : n;
    for (const it of items)
      if (plainSize(it.size) > limit("asset.fileBytes"))
        throw over(
          status,
          "asset.fileBytes",
          (m) => `a file in this bundle holds at most ${m}`,
        );
    const summaries = await assets.versionSummaries(bundle.id);
    const inFlight = (
      o.inFlight ?? (await assets.listInFlightUploads(bundle.id, now))
    ).filter((u) => !except.has(u.id));
    const added = items.filter((it) => it.newFile);
    for (const v of new Set(added.map((it) => it.version))) {
      const inVersion =
        (summaries.find((s) => s.version === v)?.files ?? 0) +
        inFlight.filter((u) => u.version === v).length +
        added.filter((it) => it.version === v).length;
      if (inVersion > limit("asset.filesPerVersion"))
        throw over(
          status,
          "asset.filesPerVersion",
          (m) => `a version holds at most ${m} files`,
        );
    }
    const versions = new Set([
      ...summaries.map((s) => s.version),
      ...inFlight.map((u) => u.version),
    ]);
    const before = versions.size;
    for (const it of items) versions.add(it.version);
    if (
      versions.size > before &&
      versions.size > limit("asset.versionsPerBundle")
    )
      throw over(
        status,
        "asset.versionsPerBundle",
        (m) => `a bundle holds at most ${m} versions`,
      );
    const files =
      summaries.reduce((n, s) => n + s.files, 0) +
      inFlight.length +
      added.length;
    if (files > limit("asset.filesPerBundle"))
      throw over(
        status,
        "asset.filesPerBundle",
        (m) => `a bundle holds at most ${m} files`,
      );
    const grow = items.reduce((n, it) => n + it.size - (it.replaces ?? 0), 0);
    const bytes =
      summaries.reduce((n, s) => n + s.bytes, 0) +
      inFlight.reduce((n, u) => n + u.size, 0);
    if (bytes + grow > limit("asset.bundleBytes"))
      throw over(
        status,
        "asset.bundleBytes",
        (m) => `bundle would exceed ${m}`,
      );
    if (bundle.projectId) {
      const p = await assets.projectAssetUsage(bundle.projectId, now, [
        ...except,
      ]);
      if (p.bytes + p.inFlightBytes + grow > limit("asset.projectBytes"))
        throw over(
          status,
          "asset.projectBytes",
          (m) => `project assets would exceed ${m}`,
        );
    }
  }

  const committer = (): AssetCommitter =>
    createAssetCommitter({
      assets,
      store: requireStore(),
      cdnBaseUrl,
      clock,
      logger,
      ...(sleep ? { sleep } : {}),
      checkQuota: (bundle, items, except) =>
        checkQuota(bundle, items, nowSec(clock), "conflict", { except }),
    });

  /**
   * Deletes the objects of `rows` in `DeleteObjects` batches, then the rows
   * whose object went: a failed delete keeps its row, because `assets/` is
   * outside every sweep and a stranded public object could never be
   * reclaimed. The immutable files of a live bundle leave tombstones.
   */
  async function deleteRows(
    store: ArtifactStore,
    rows: readonly AssetFileRow[],
    tomb: boolean,
  ): Promise<{ deleted: AssetFileRow[]; failed: AssetFileRow[] }> {
    if (rows.length === 0) return { deleted: [], failed: [] };
    const { failed } = await store.deleteMany(rows.map((r) => r.objectKey));
    if (failed.length > 0)
      logger.warn("asset object delete failed", {
        count: failed.length,
        key: failed[0]!.key,
        code: failed[0]!.code,
      });
    const bad = new Set(failed.map((f) => f.key));
    const gone = rows.filter((r) => !bad.has(r.objectKey));
    const kept = rows.filter((r) => bad.has(r.objectKey));
    const tombs = gone.filter((r) => tomb && !r.mutable && r.sha256 !== null);
    if (tombs.length > 0)
      await assets.insertTombstones(
        tombs[0]!.bundleId,
        tombs.map((r) => ({ path: r.path, sha256: r.sha256! })),
        nowSec(clock),
      );
    await assets.deleteFiles(gone.map((r) => r.id));
    return { deleted: gone, failed: kept };
  }

  /**
   * Walks the bundle (or one version) a batch at a time until it is empty or
   * the budget is spent. `done: false` answers 202 with the progress; the
   * caller repeats the delete (the CLI and SPA do), which resumes because
   * the deleted rows are gone.
   */
  async function deleteAll(
    bundle: AssetBundleRow,
    version: string | undefined,
  ): Promise<{ done: boolean; deleted: number; failed: number }> {
    const deadline = nowMs(clock) + deleteBudgetMs;
    let afterId: string | undefined;
    let deleted = 0;
    let failed = 0;
    for (;;) {
      const rows = await assets.listFileBatch(bundle.id, {
        ...(version !== undefined ? { version } : {}),
        ...(afterId !== undefined ? { afterId } : {}),
        limit: DELETE_OBJECTS_MAX,
      });
      if (rows.length === 0) return { done: true, deleted, failed };
      const r = await deleteRows(requireStore(), rows, false);
      deleted += r.deleted.length;
      failed += r.failed.length;
      afterId = rows[rows.length - 1]!.id;
      // A short batch was the last one: never answer 202 over nothing left,
      // or the repeat of a version delete finds no version and 404s before
      // it drops the version's links.
      if (rows.length < DELETE_OBJECTS_MAX)
        return { done: true, deleted, failed };
      if (
        nowMs(clock) >= deadline &&
        (
          await assets.listFileBatch(bundle.id, {
            ...(version !== undefined ? { version } : {}),
            afterId,
            limit: 1,
          })
        ).length > 0
      )
        return { done: false, deleted, failed };
    }
  }

  const progress = (p: { deleted: number; failed: number }): HttpResult =>
    json({ done: false, ...p }, { status: 202 });

  /**
   * Lobby channels **of this team** whose `mapUrl` points inside any of
   * `prefixes`. Deleting what a channel still serves is not a degraded game
   * but one that cannot load at all, and the URL is cached `immutable`, so
   * this is checked before the delete rather than repaired after it. Another
   * team's lobby does not count: no team may hold another's bundle — and its
   * storage limit — hostage (docs/decisions.md *Live and encrypted asset
   * bundles* #2).
   */
  async function referencingChannels(
    prefixes: string[],
    teamId: string | null,
  ): Promise<string[]> {
    if (teamId === null || prefixes.length === 0) return [];
    // `artifactUrl` trims the trailing slash; put it back so `maps` does not
    // match `maps2` and version `1.0` does not match `1.0.1`.
    const urls = prefixes.map((p) => `${artifactUrl(cdnBaseUrl, p)}/`);
    const out: string[] = [];
    for (const row of await db.listChannels({ kind: "lobby", teamId })) {
      let mapUrl: unknown;
      try {
        mapUrl = (JSON.parse(row.configJson) as { mapUrl?: unknown }).mapUrl;
      } catch {
        continue; // unparseable config cannot be pointing anywhere
      }
      if (typeof mapUrl === "string" && urls.some((u) => mapUrl.startsWith(u)))
        out.push(row.id);
    }
    return out;
  }

  function assertUnreferenced(channels: string[], what: string): void {
    if (channels.length === 0) return;
    throw new AppError(
      "conflict",
      `${what} is still the map of ${channels.length} lobby channel(s); re-point them first`,
      { details: { channels } },
    );
  }

  function requireLive(bundle: AssetBundleRow): void {
    if (bundle.mode !== "live")
      throw new AppError(
        "bad_request",
        "only a live bundle changes single files; publish a new version",
      );
  }

  /**
   * The version a request names, checked against the bundle's mode: a live
   * bundle takes none, a versioned one needs one.
   */
  function versionFor(bundle: AssetBundleRow, v: string | undefined): string {
    if (bundle.mode === "live") {
      if (v !== undefined)
        throw new AppError("bad_request", "a live bundle takes no version");
      return LIVE_VERSION;
    }
    if (v === undefined)
      throw new AppError("bad_request", "version is required");
    return v;
  }

  /** Commit results that the caller can act on one by one. */
  const errorOf = (e: unknown) =>
    e instanceof AppError
      ? {
          code: e.code,
          message: e.message,
          ...(e.details !== undefined ? { details: e.details } : {}),
        }
      : { code: "unavailable", message: "internal error" };

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
        const mode = ctx.body.mode ?? "versioned";
        const encrypted = ctx.body.encrypted ?? false;
        // The key is minted here and stored wrapped; the console never sees
        // it again except to hand it to the team (`POST …/key`).
        const key = encrypted ? requireKeyring().mint(bundleId) : undefined;
        await assets.insertBundle({
          id: bundleId,
          name: ctx.body.name,
          description: ctx.body.description ?? null,
          ownerId: a.id.subject,
          teamId: a.team.id,
          projectId: a.project.id,
          mode,
          ...(key ? { key } : {}),
          createdAt: now,
        });
        await audit(a.id.subject, "asset.bundle.create", bundleId, {
          name: ctx.body.name,
          projectId: a.project.id,
          mode,
          ...(encrypted ? { encrypted } : {}),
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
    {
      // A POST so that the console's Origin check applies: a GET would let
      // any same-site page make a member's browser write audit rows in
      // their name (decisions #4, rules/security.md).
      method: "POST",
      path: "/assets/bundles/{bundle}/key",
      auth: true,
      handler: async (ctx) => {
        // `secret: true`: a seatless admin gets 403, as for every secret.
        const { id, row: bundle } = await bundleWith(ctx, true);
        if (!bundle.encrypted)
          throw new AppError("bad_request", "this bundle is not encrypted");
        const ring = requireKeyring();
        const row = await assets.findBundleKey(bundle.id);
        if (!row)
          // The same body as every other failure to read it (no oracle).
          throw new AppError("unavailable", "asset key cannot be read", {
            cause: new Error("no key row for an encrypted bundle"),
            details: { reason: "asset_key_unreadable" },
          });
        await writeSlot(id);
        const key = ring.reveal(row);
        // The key never enters a log line; the audit row says who read which.
        await audit(id.subject, "asset.key.read", bundle.id, {});
        return json(
          { bundleId: bundle.id, key, format: ASSET_ENC_FORMAT },
          { noStore: true },
        );
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
        assertUnreferenced(
          await referencingChannels(
            await assets.objectKeyPrefixes(bundle.id),
            bundle.teamId,
          ),
          `bundle "${bundle.name}"`,
        );
        await abortOpenUploads(bundle);
        // An empty bundle is just a row: it stays deletable even when no
        // artifact bucket is configured (`deleteAll` asks for the store only
        // once it has a row to delete).
        const r = await deleteAll(bundle, undefined);
        if (!r.done) return progress(r);
        if (r.failed > 0)
          throw new AppError(
            "unavailable",
            `${r.failed} object(s) could not be deleted; retry`,
          );
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
        if (bundle.mode === "live")
          throw new AppError("not_found", "a live bundle has no versions");
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
      query: filePageQuery.extend({
        version: version.optional(),
        /** One exact path instead of a page (what `yyt asset download` asks). */
        path: relativePath.optional(),
      }),
      handler: async (ctx) => {
        const { row: bundle } = await bundleWith(ctx, false);
        const v = versionFor(bundle, ctx.query.version);
        const page =
          ctx.query.path !== undefined
            ? {
                rows: await assets.findFilesByPaths(bundle.id, v, [
                  ctx.query.path,
                ]),
                next: null,
              }
            : await assets.listFilesPage(bundle.id, v, {
                after: ctx.query.cursor,
                limit: ctx.query.limit,
              });
        return {
          bundleId: bundle.id,
          mode: bundle.mode,
          version: bundle.mode === "live" ? null : v,
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
        const version = ctx.params.version!;
        if (
          bundle.mode === "live" ||
          !(await assets.hasVersion(bundle.id, version))
        )
          throw new AppError("not_found", "version not found");
        assertUnreferenced(
          await referencingChannels(
            await assets.objectKeyPrefixes(bundle.id, version),
            bundle.teamId,
          ),
          `version "${version}"`,
        );
        await abortOpenUploads(bundle, version);
        const r = await deleteAll(bundle, version);
        if (!r.done) return progress(r);
        if (r.failed > 0)
          throw new AppError(
            "unavailable",
            `${r.failed} object(s) could not be deleted; retry`,
          );
        // A project version pointing at this asset version now dangles; the
        // link table only cascades on the bundle, so drop those rows here.
        await team.removeAssetVersionLinks(bundle.id, version);
        await audit(id.subject, "asset.version.delete", bundle.id, {
          version,
          files: r.deleted,
        });
        await bundleHistory(bundle, id.subject, "resource.update", [
          `version:${version}:delete`,
        ]);
        return undefined;
      },
    },
    defineRoute({
      method: "POST",
      path: "/assets/bundles/{bundle}/files",
      auth: true,
      body: presignBody,
      handler: async (ctx) => {
        const { id, row: bundle } = await bundleWith(ctx, true);
        const store = requireStore();
        const batch = "files" in ctx.body;
        const specs = "files" in ctx.body ? ctx.body.files : [ctx.body];
        const v = versionFor(bundle, ctx.body.version);
        const live = bundle.mode === "live";
        const enc = bundle.encrypted;
        if (enc && ctx.body.format !== ASSET_ENC_FORMAT)
          throw new AppError(
            "bad_request",
            `this bundle is encrypted: uploads carry format "${ASSET_ENC_FORMAT}" (yyt asset sync from cli/v0.12.0)`,
          );
        if (!enc && ctx.body.format !== undefined)
          throw new AppError(
            "bad_request",
            "format applies to an encrypted bundle",
          );
        const paths = specs.map((s) => s.path);
        if (new Set(paths).size !== paths.length)
          throw new AppError("bad_request", "a path appears twice");
        const types = specs.map((s) => {
          // The extension rule still applies (nothing scriptable, even by
          // name); the stored type of ciphertext is octet-stream regardless.
          const extType = assetContentType(s.path);
          const type = enc ? ASSET_CONTENT_TYPES[".bin"]! : extType;
          if (enc && !s.sha256)
            throw new AppError(
              "bad_request",
              "sha256 is required in an encrypted bundle",
              { details: { path: s.path } },
            );
          if (enc && !isAssetCiphertextLength(s.size))
            throw new AppError(
              "bad_request",
              `size is not a yyt-enc v1 ciphertext length (at least ${ASSET_ENC_MIN_BYTES} bytes, 32-byte tag per 64 KiB segment)`,
              { details: { path: s.path, reason: "not_ciphertext" } },
            );
          if (live && !s.sha256)
            throw new AppError(
              "bad_request",
              "sha256 is required in a live bundle",
              { details: { path: s.path } },
            );
          // Every part carries a checksum, and the file's own sha256 is what
          // the resume and the file row are keyed on (decisions #3, #6).
          if (s.size > MULTIPART_THRESHOLD_BYTES && !s.sha256)
            throw new AppError(
              "bad_request",
              "sha256 is required for a file uploaded in parts",
              { details: { path: s.path } },
            );
          if (!live && (s.mutable || s.ifSha256))
            throw new AppError(
              "bad_request",
              "only a live bundle holds mutable files",
            );
          if (s.ifSha256 && !s.mutable)
            throw new AppError(
              "bad_request",
              "ifSha256 applies to a mutable file",
            );
          if (s.mutable && !MUTABLE_CONTENT_TYPES.has(extType))
            throw new AppError(
              "bad_request",
              "a mutable file is .json or .txt",
              { details: { path: s.path } },
            );
          return type;
        });
        const now = nowSec(clock);
        const lim = await limitsOf(bundle, now);
        const { limit, over } = lim;
        const mutableMax = limit("asset.mutableFileBytes");
        for (const s of specs)
          if (s.mutable && s.size > mutableMax)
            throw over(
              "bad_request",
              "asset.mutableFileBytes",
              (m) => `a mutable file holds at most ${m}`,
            );
        const existing = new Map(
          (await assets.findFilesByPaths(bundle.id, v, paths)).map((f) => [
            f.path,
            f,
          ]),
        );
        const inFlight = await assets.listInFlightUploads(bundle.id, now);
        const tombs = live
          ? await assets.findTombstones(
              bundle.id,
              paths,
              now - ASSET_TOMBSTONE_SEC,
            )
          : [];
        const present = new Map<string, AssetFileRow>();
        const items: QuotaItem[] = [];
        for (const s of specs) {
          const ex = existing.get(s.path);
          if (!live) {
            // Write-once: the object is `immutable`, so a second upload to the
            // same (version, path) could never reach a client that already
            // cached it. A presign in flight holds the path too — unless both
            // name the same bytes (a sync run again after a failed PUT),
            // which the commit's claim settles either way.
            if (ex && s.sha256 && ex.sha256 === s.sha256) {
              await requireCommitted(ex);
              present.set(s.path, ex);
              continue;
            }
            if (
              ex ||
              inFlight.some(
                (u) =>
                  u.version === v &&
                  u.path === s.path &&
                  (!s.sha256 || u.sha256 !== s.sha256),
              )
            )
              throw new AppError(
                "conflict",
                "this path already exists in this version; publish a new version",
                { details: { path: s.path } },
              );
            items.push({ version: v, size: s.size, newFile: true });
            continue;
          }
          const t = tombs.filter(
            (x) => x.path === s.path && x.sha256 !== s.sha256,
          );
          if (t.length > 0)
            throw tombstoned(
              s.path,
              Math.max(...t.map((x) => x.deletedAt)) + ASSET_TOMBSTONE_SEC,
            );
          if (!ex) {
            if (s.ifSha256)
              throw new AppError(
                "conflict",
                `"${s.path}" is not the file you expected`,
                { details: { path: s.path, sha256: null } },
              );
            items.push({ version: v, size: s.size, newFile: true });
            continue;
          }
          if (ex.mutable !== (s.mutable ?? false))
            throw new AppError(
              "conflict",
              ex.mutable
                ? `"${s.path}" is a mutable file`
                : `"${s.path}" is an immutable file`,
              { details: { path: s.path, mutable: ex.mutable } },
            );
          if (s.ifSha256 && ex.sha256 !== s.ifSha256)
            throw new AppError(
              "conflict",
              `"${s.path}" is not the file you expected`,
              { details: { path: s.path, sha256: ex.sha256 } },
            );
          if (ex.sha256 === s.sha256) {
            await requireCommitted(ex);
            present.set(s.path, ex);
            continue;
          }
          if (!ex.mutable)
            throw new AppError(
              "conflict",
              `"${s.path}" already holds other bytes; an immutable file never changes`,
              { details: { path: s.path, sha256: ex.sha256 } },
            );
          items.push({
            version: v,
            size: s.size,
            newFile: false,
            replaces: ex.size,
          });
        }
        await checkQuota(bundle, items, now, "bad_request", { inFlight, lim });
        const expiresAt = now + ARTIFACT_UPLOAD_URL_TTL_SEC;
        const multipartExpiresAt = now + MULTIPART_UPLOAD_TTL_SEC;
        const out: Array<
          | ({ path: string } & ReturnType<typeof grantBody>)
          | ({ path: string } & ReturnType<typeof multipartGrant>)
          | {
              path: string;
              alreadyPresent: true;
              file: ReturnType<typeof fileView>;
            }
        > = [];
        const granted: { uploadId: string; path: string }[] = [];
        const rows: Parameters<AssetsDb["insertUploads"]>[0][number][] = [];
        const multiparts: {
          uploadId: string;
          key: string;
          contentType: string;
        }[] = [];
        for (const [i, s] of specs.entries()) {
          const ex = present.get(s.path);
          if (ex) {
            out.push({
              path: s.path,
              alreadyPresent: true,
              file: fileView(ex),
            });
            continue;
          }
          const uploadId = randomHex(16);
          const contentType = types[i]!;
          const multipart = s.size > MULTIPART_THRESHOLD_BYTES;
          rows.push({
            id: uploadId,
            bundleId: bundle.id,
            version: v,
            path: s.path,
            contentType,
            size: s.size,
            sha256: s.sha256 ?? null,
            mutable: s.mutable ?? false,
            ifSha256: s.ifSha256 ?? null,
            ...(multipart
              ? {
                  partSize: MULTIPART_PART_BYTES,
                  partCount: multipartPartCount(s.size),
                }
              : {}),
            createdAt: now,
            expiresAt: multipart ? multipartExpiresAt : expiresAt,
          });
          granted.push({ uploadId, path: s.path });
          if (multipart) {
            // The multipart upload is opened at the file's final key, once
            // its row exists (below): a row without an upload expires, an
            // upload without a row would be billed parts nobody aborts.
            const key = assetObjectKey(bundle, v, s.path);
            multiparts.push({ uploadId, key, contentType });
            out.push({
              path: s.path,
              ...multipartGrant({
                uploadId,
                key,
                size: s.size,
                sha256: s.sha256!,
                contentType,
                expiresAt: multipartExpiresAt,
              }),
            });
            continue;
          }
          const key = assetStagingKey(uploadId, s.path);
          // Signing is local (no request), so a hundred of these are cheap.
          const url = await store.presignPut({
            key,
            contentLength: s.size,
            contentType,
            ...(s.sha256 ? { sha256: s.sha256 } : {}),
          });
          out.push({
            path: s.path,
            ...grantBody({
              uploadId,
              key,
              url,
              contentType,
              size: s.size,
              expiresAt,
              sha256: s.sha256 ?? null,
            }),
          });
        }
        // Every reservation in one statement, before any URL leaves.
        await assets.insertUploads(rows);
        const opened: { key: string; s3UploadId: string }[] = [];
        for (const m of multiparts) {
          let s3UploadId: string;
          try {
            ({ uploadId: s3UploadId } = await store.createMultipart({
              key: m.key,
              contentType: m.contentType,
              cacheControl: ASSET_CACHE_CONTROL,
            }));
          } catch (e) {
            // Nothing of this call leaves: the uploads it opened are aborted
            // (billed parts nobody would name), its multipart rows spent, and
            // the caller presigns again. The single-PUT reservations of the
            // call expire in their hour.
            for (const o of opened)
              await store
                .abortMultipart(o.key, o.s3UploadId)
                .catch(() => undefined);
            for (const x of multiparts)
              await assets
                .updateUpload(x.uploadId, {
                  status: "failed",
                  s3UploadId: null,
                })
                .catch(() => undefined);
            throw new AppError(
              "unavailable",
              "artifact storage could not open the upload; presign again",
              { cause: e },
            );
          }
          opened.push({ key: m.key, s3UploadId });
          await assets.updateUpload(m.uploadId, { s3UploadId });
        }
        if (granted.length > 0)
          await audit(id.subject, "asset.file.upload", bundle.id, {
            version: v,
            ...(batch
              ? { uploads: granted }
              : { uploadId: granted[0]!.uploadId, path: granted[0]!.path }),
          });
        if (batch)
          return json({ uploads: out }, { status: 201, noStore: true });
        const one = out[0]!;
        if ("alreadyPresent" in one)
          return json(
            { alreadyPresent: true, file: one.file },
            { noStore: true },
          );
        if ("multipart" in one) {
          const { path: _path, ...grant } = one;
          return json(grant, { status: 201, noStore: true });
        }
        return uploadGrant({
          uploadId: one.uploadId,
          key: one.key,
          url: one.url,
          contentType: types[0]!,
          size: specs[0]!.size,
          expiresAt,
          sha256: specs[0]!.sha256 ?? null,
        });
      },
    }),
    defineRoute({
      method: "PATCH",
      path: "/assets/bundles/{bundle}/files",
      auth: true,
      body: fileMarkBody,
      handler: async (ctx) => {
        const { row: bundle } = await bundleWith(ctx, true);
        requireLive(bundle);
        const now = nowSec(clock);
        const stale = ctx.body.stale?.length
          ? await assets.setStale(bundle.id, ctx.body.stale, now)
          : 0;
        const fresh = ctx.body.fresh?.length
          ? await assets.setStale(bundle.id, ctx.body.fresh, null)
          : 0;
        return { stale, fresh };
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/assets/bundles/{bundle}/files",
      auth: true,
      body: fileDeleteBody,
      handler: async (ctx) => {
        const { id, row: bundle } = await bundleWith(ctx, true);
        requireLive(bundle);
        await writeSlot(id);
        const rows = await assets.findFilesByPaths(
          bundle.id,
          LIVE_VERSION,
          ctx.body.paths,
        );
        const found = new Set(rows.map((r) => r.path));
        const missing = ctx.body.paths.filter((p) => !found.has(p));
        // A row whose upload has not completed is a claim with its copy
        // possibly in flight: deleting now could let that copy land after
        // the delete, an object no row names.
        const claims = new Set(
          (
            await assets.listUploadsByIds(
              rows
                .filter((f) => f.id.startsWith("af_"))
                .map((f) => f.id.slice(3)),
            )
          )
            .filter((u) => u.status !== "completed")
            .map((u) => `af_${u.id}`),
        );
        const busy = rows.filter((f) => claims.has(f.id));
        const settled = rows.filter((f) => !claims.has(f.id));
        const skipped = ctx.body.stale
          ? settled.filter((r) => r.staleSince === null)
          : [];
        const doomed = ctx.body.stale
          ? settled.filter((r) => r.staleSince !== null)
          : settled;
        const r =
          doomed.length > 0
            ? await deleteRows(requireStore(), doomed, true)
            : { deleted: [] as AssetFileRow[], failed: [] as AssetFileRow[] };
        r.failed.push(...busy);
        if (r.deleted.length > 0) {
          await audit(id.subject, "asset.file.delete", bundle.id, {
            files: r.deleted.length,
            stale: ctx.body.stale ?? false,
          });
          await bundleHistory(bundle, id.subject, "resource.update", [
            `files:delete:${r.deleted.length}`,
          ]);
        }
        return {
          deleted: r.deleted.map((f) => f.path),
          missing,
          skipped: skipped.map((f) => f.path),
          failed: r.failed.map((f) => f.path),
        };
      },
    }),
    {
      method: "GET",
      path: "/assets/uploads/{id}",
      auth: true,
      handler: async (ctx) => uploadView((await uploadWith(ctx)).upload),
    },
    defineRoute({
      method: "POST",
      path: "/assets/uploads/{id}/parts",
      auth: true,
      body: partsBody,
      handler: async (ctx) => {
        const { upload: u, row: bundle } = await uploadWith(ctx);
        const store = requireStore();
        if (u.s3UploadId === null)
          throw new AppError(
            "bad_request",
            "this upload is a single PUT; it has no parts",
          );
        if (u.status !== "pending")
          throw new AppError("conflict", `upload is ${u.status}`);
        const now = nowSec(clock);
        if (now > u.expiresAt) throw new AppError("conflict", "upload expired");
        const count = u.partCount ?? multipartPartCount(u.size);
        const seen = new Set<number>();
        for (const p of ctx.body.parts) {
          if (p.partNumber > count)
            throw new AppError(
              "bad_request",
              `this upload has ${count} part(s)`,
              { details: { partNumber: p.partNumber } },
            );
          if (seen.has(p.partNumber))
            throw new AppError("bad_request", "a part appears twice", {
              details: { partNumber: p.partNumber },
            });
          seen.add(p.partNumber);
        }
        const key = assetObjectKey(bundle, u.version, u.path);
        // Part URLs live the hour of a single PUT (the upload a day):
        // a resume asks for them again.
        const expiresAt = Math.min(
          u.expiresAt,
          now + ARTIFACT_UPLOAD_URL_TTL_SEC,
        );
        const parts = [];
        for (const p of ctx.body.parts) {
          const contentLength = multipartPartSize(u, p.partNumber);
          const url = await store.presignPart({
            key,
            uploadId: u.s3UploadId,
            partNumber: p.partNumber,
            contentLength,
            sha256: p.sha256,
            ttlSec: expiresAt - now,
          });
          parts.push({
            partNumber: p.partNumber,
            url,
            method: "PUT" as const,
            headers: {
              "content-length": String(contentLength),
              "x-amz-checksum-sha256": sha256Base64(p.sha256),
            },
          });
        }
        return json(
          {
            uploadId: u.id,
            key,
            partSize: u.partSize ?? MULTIPART_PART_BYTES,
            partCount: count,
            expiresAt,
            parts,
          },
          { status: 201, noStore: true },
        );
      },
    }),
    {
      method: "GET",
      path: "/assets/uploads/{id}/parts",
      auth: true,
      handler: async (ctx) => {
        const { upload: u, row: bundle } = await uploadWith(ctx);
        const store = requireStore();
        if (u.s3UploadId === null)
          throw new AppError(
            "bad_request",
            "this upload is a single PUT; it has no parts",
          );
        const key = assetObjectKey(bundle, u.version, u.path);
        let open = true;
        let parts: Awaited<ReturnType<ArtifactStore["listParts"]>> = [];
        try {
          parts = await store.listParts(key, u.s3UploadId);
        } catch (e) {
          if (!(e instanceof MultipartGoneError)) throw e;
          open = false;
        }
        return json(
          {
            uploadId: u.id,
            status: u.status,
            partSize: u.partSize ?? MULTIPART_PART_BYTES,
            partCount: u.partCount ?? multipartPartCount(u.size),
            open,
            parts,
          },
          { noStore: true },
        );
      },
    },
    {
      method: "DELETE",
      path: "/assets/uploads/{id}",
      auth: true,
      handler: async (ctx) => {
        const { id, upload: u, row: bundle } = await uploadWith(ctx);
        if (u.status === "completed")
          throw new AppError("conflict", "upload is completed");
        if (u.fileId !== null || u.status === "completing")
          // A claim in flight or unsettled: only its commit or the sweep may
          // decide what the key holds.
          throw new AppError(
            "conflict",
            "this upload is being committed; the daily sweep settles it",
          );
        await writeSlot(id);
        const store = requireStore();
        if (u.s3UploadId !== null) {
          const key = assetObjectKey(bundle, u.version, u.path);
          const r = await store.abortMultipart(key, u.s3UploadId);
          // Gone can mean completed by a commit this row did not record yet.
          if (r === "gone" && (await store.inspect(key)).state !== "absent")
            throw new AppError("conflict", "upload is completed");
        } else
          await store
            .delete(assetStagingKey(u.id, u.path))
            .catch(() => undefined);
        await assets.deleteUpload(u.id);
        await audit(id.subject, "asset.upload.abort", bundle.id, {
          uploadId: u.id,
          path: u.path,
          multipart: u.s3UploadId !== null,
        });
        return undefined;
      },
    },
    {
      method: "POST",
      path: "/assets/uploads/{id}/commit",
      auth: true,
      handler: async (ctx) => {
        const { id, upload, row: bundle } = await uploadWith(ctx);
        const { file, alreadyPresent } = await committer().commit(
          upload,
          bundle,
        );
        await audit(id.subject, "asset.file.commit", file.id, {
          bundleId: bundle.id,
          version: upload.version,
          path: upload.path,
          ...(alreadyPresent ? { alreadyPresent } : {}),
        });
        return fileView(file);
      },
    },
    defineRoute({
      method: "POST",
      path: "/assets/uploads/commit",
      auth: true,
      body: assetCommitBatchBody,
      handler: async (ctx) => {
        const ids = [...new Set(ctx.body.ids)];
        const notFound = (uploadId: string) => ({
          uploadId,
          error: { code: "not_found", message: "upload not found" },
        });
        // Authorize every bundle the ids name before saying anything about
        // them: an id of a bundle the caller cannot write answers exactly
        // like one that never existed.
        const found = await assets.listUploadsByIds(ids);
        const allowed = new Map<string, ResourceAccess<"bundle">>();
        for (const bundleId of new Set(found.map((u) => u.bundleId))) {
          try {
            allowed.set(
              bundleId,
              await projectResource(
                ctx,
                { kind: "bundle", id: bundleId },
                { secret: true },
              ),
            );
          } catch (e) {
            if (!(e instanceof AppError) || e.code !== "not_found") throw e;
          }
        }
        const uploads = found.filter((u) => allowed.has(u.bundleId));
        if (allowed.size > 1)
          throw new AppError(
            "bad_request",
            "a batch commits uploads of one bundle",
          );
        const byId = new Map(uploads.map((u) => [u.id, u]));
        if (uploads.length === 0) return { results: ids.map(notFound) };
        const { id, row: bundle } = allowed.get(uploads[0]!.bundleId)!;
        const c = committer();
        // One quota check for the whole batch: its own reservations are the
        // files it writes, so what must fit is what is already reserved. A
        // mutable file over an existing one adds no file and only its growth.
        const pending = uploads.filter((u) => u.status === "pending");
        const current = new Map(
          (
            await assets.findFilesByPaths(
              bundle.id,
              LIVE_VERSION,
              pending.filter((u) => u.mutable).map((u) => u.path),
            )
          ).map((f) => [f.path, f]),
        );
        await checkQuota(
          bundle,
          pending.map((u) => {
            const ex = u.mutable ? current.get(u.path) : undefined;
            return {
              version: u.version,
              size: u.size,
              newFile: !ex,
              ...(ex ? { replaces: ex.size } : {}),
            };
          }),
          nowSec(clock),
          "conflict",
          { except: pending.map((u) => u.id) },
        );
        const results = new Map<string, unknown>();
        const committed: { fileId: string; path: string }[] = [];
        const deadline = nowMs(clock) + commitBudgetMs;
        const one = async (uploadId: string): Promise<void> => {
          const u = byId.get(uploadId);
          if (!u) {
            results.set(uploadId, notFound(uploadId));
            return;
          }
          if (nowMs(clock) >= deadline) {
            // Still pending: the caller commits it again.
            results.set(uploadId, {
              uploadId,
              error: {
                code: "unavailable",
                message: "out of time for this request; commit it again",
              },
            });
            return;
          }
          try {
            const { file, alreadyPresent } = await c.commit(u, bundle, {
              quota: false,
            });
            committed.push({ fileId: file.id, path: file.path });
            results.set(uploadId, {
              uploadId,
              file: fileView(file),
              ...(alreadyPresent ? { alreadyPresent } : {}),
            });
          } catch (e) {
            if (!(e instanceof AppError)) throw e;
            results.set(uploadId, { uploadId, error: errorOf(e) });
          }
        };
        // A few at a time: each commit is two or three S3 calls, and one at a
        // time would spend the request budget on round trips.
        const queue = [...ids];
        await Promise.all(
          Array.from(
            { length: Math.min(ASSET_COMMIT_CONCURRENCY, queue.length) },
            async () => {
              for (let next = queue.shift(); next; next = queue.shift())
                await one(next);
            },
          ),
        );
        if (committed.length > 0)
          await audit(id.subject, "asset.file.commit", bundle.id, {
            bundleId: bundle.id,
            files: committed,
          });
        return { results: ids.map((i) => results.get(i)) };
      },
    }),
  ];
}
