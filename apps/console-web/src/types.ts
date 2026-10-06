export type Role = "admin" | "member" | "pending";
export type ChannelKind = "auth" | "topic" | "match" | "lobby" | "q" | "push";
/** Kinds served by the self-hosted realtime gateway; neither carries a secret. */
export const GATEWAY_KINDS = ["lobby", "q"] as const;
export type ChannelStatus = "active" | "expired" | "disabled";
export type EventStatus =
  "draft" | "voting" | "waiting" | "opened" | "closed" | "cancelled";

/** The happy path in order; `cancelled` sits beside it. */
export const EVENT_STATUSES: readonly EventStatus[] = [
  "draft",
  "voting",
  "waiting",
  "opened",
  "closed",
];

export interface Me {
  id: string;
  login: string;
  role: Role;
  via: "session" | "token";
}

export interface Member {
  id: string;
  login: string;
  role: Role;
  createdAt: number;
  approvedAt: number | null;
  approvedBy: string | null;
}

export interface ApiToken {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

// ---- teams and projects ----------------------------------------------------

export type TeamRole = "owner" | "member" | "pending";
/** The caller's standing in a team: `admin` = platform admin without a seat. */
export type TeamStanding = TeamRole | "admin";
export type TeamMemberState = "active" | "declined" | "kicked";

/** Every team standing that may read and write the team's projects. */
export const canWriteTeam = (standing: TeamStanding | undefined): boolean =>
  standing === "owner" || standing === "member";
export const isTeamOwner = (standing: TeamStanding | undefined): boolean =>
  standing === "owner";

/**
 * A team as listed for its members. A `pending` requester only gets the
 * name-only shape (`description` and the rest are absent).
 */
export interface Team {
  id: string;
  name: string;
  role: TeamStanding;
  description?: string | null;
  adminLocked?: boolean;
  createdBy?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface TeamDetail extends Team {
  counts?: {
    owners: number;
    members: number;
    pending: number;
    projects: number;
  };
}

export interface TeamMember {
  id: string;
  login: string | null;
  platformRole: Role | null;
  role: TeamRole;
  state: TeamMemberState;
  requestedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

/** Channels whose credentials a departed member still knows. */
export interface RotationHint {
  id: string;
  kind: ChannelKind;
  name: string;
}

/** Encrypted asset bundles whose key a departed member could have read. */
export interface EncryptedBundleHint {
  id: string;
  name: string;
}

export interface RemoveMemberResult {
  removed: string;
  action: "leave" | "kick";
  rotate: RotationHint[];
  encryptedBundles: EncryptedBundleHint[];
}

export interface TeamHistoryEntry {
  id: string;
  at: number;
  actor: string | null;
  action: string;
  subject: string | null;
  target: string | null;
  detail: Record<string, unknown> | null;
}

export interface HistoryPage {
  history: TeamHistoryEntry[];
  next: string | null;
}

export interface Comment {
  id: string;
  bodyMd: string;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  mine: boolean;
}

/** A list row: the body travels only with the detail. */
export interface Discussion {
  id: string;
  teamId: string;
  title: string;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  mine: boolean;
}

export interface DiscussionDetail extends Discussion {
  bodyMd: string;
  comments: Comment[];
}

export interface Project {
  id: string;
  teamId: string;
  teamName: string;
  name: string;
  description: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectDetail extends Project {
  counts: {
    channels: number;
    apps: number;
    bundles: number;
    sites: number;
    kv: number;
    lb: number;
    versions: number;
    issues: number;
  };
}

export interface Version {
  id: string;
  projectId: string;
  name: string;
  note: string | null;
  createdBy: string | null;
  createdAt: number;
  /** Live links per kind; an artifact removed by the retention policy drops out. */
  artifactCount: number;
  assetCount: number;
}

export type VersionLinkKind = "artifact" | "asset_version";

export interface VersionLink {
  id: string;
  versionId: string;
  kind: VersionLinkKind;
  artifactId: string | null;
  bundleId: string | null;
  assetVersion: string | null;
  createdAt: number;
  /** The detail names its targets; the create response does not. `null` = vanished. */
  artifact?: {
    appId: string;
    appName: string;
    platform: CatalogPlatform;
    version: string | null;
    /** What tells one build of a version from another (per-ABI, debug/release). */
    abi: string | null;
    buildType: string | null;
    url: string;
    createdAt: number;
  } | null;
  bundleName?: string | null;
}

export interface VersionDetail extends Version {
  links: VersionLink[];
}

export type VersionLinkInput =
  | { kind: "artifact"; artifactId: string }
  | { kind: "asset_version"; bundleId: string; assetVersion: string };

export type IssueStatus = "open" | "closed";

/** A list row: the body travels only with the detail. */
export interface Issue {
  id: string;
  projectId: string;
  number: number;
  title: string;
  status: IssueStatus;
  versionId: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface IssueDetail extends Issue {
  bodyMd: string;
  comments: Comment[];
}

/** Breadcrumb fields every resource view carries (null on unmapped legacy rows). */
export interface ResourceCrumbs {
  teamId: string | null;
  teamName: string | null;
  projectId: string | null;
  projectName: string | null;
  createdBy: string | null;
}

export interface InstallerAppSetting {
  appId: string | null;
  appName: string | null;
  teamId: string | null;
  teamName: string | null;
  /** The downloads route serves only while this is true. */
  trusted: boolean;
  updatedAt: number | null;
}

// ---- channels ---------------------------------------------------------------

/**
 * `expiresAt` of a channel granted no expiry (9999-12-31T23:59:59Z,
 * docs/decisions.md *Limit requests* #7); `isNoExpiry` in `lib/format.ts`.
 */
export const CHANNEL_NO_EXPIRY_SEC = 253402300799;

export interface AuthConfig {
  audience: string;
  tokenTtlSec: number;
  redirectAllowlist: string[];
  providers: { github?: { clientId: string }; google?: { clientId: string } };
}
export interface TopicConfig {
  authChannelId: string;
}
/** `live`: players wait on a WebSocket. `deferred`: a ticket is an HTTP resource. */
export type MatchMode = "live" | "deferred";
export interface MatchConfig {
  authChannelId: string;
  partySize: number;
  waitTimeoutSec: number;
  onTimeout: "partial" | "fail";
  /** Absent = the callback-less mode: members arrange the room themselves. */
  callbackUrl?: string;
  /** Fixed at creation. A live channel is stored without the key. */
  mode?: MatchMode;
  // deferred only
  acceptTimeoutSec?: number;
  resultTtlSec?: number;
  /** A push channel of the same project on the same auth channel. */
  pushChannelId?: string;
}
export type SayScope = "zone" | "party" | "user";
export interface LobbyCapabilities {
  pos: boolean;
  say: SayScope[];
  party: boolean;
  event: boolean;
  debug: boolean;
}
export interface LobbyConfig {
  authChannelId: string;
  capabilities: LobbyCapabilities;
  flushIntervalMs: number;
  maxMoveDelta: number;
  rateLimit: number;
  partySizeMax: number;
  defaultZone: string;
  mapUrl: string;
  /** Nearest peers in view, always applied (1–256); rows saved before it existed omit it (64). */
  maxPeers?: number;
  /** Optional area-of-interest box in tiles; `maxPeers` inside it is a legacy row (read only). */
  aoi?: { range: number; maxPeers?: number };
}
export interface QConfig {
  authChannelId: string;
}
/** `q` only: Redis names derived from the channel id, copied into tslib config verbatim. */
export interface GatewayRedis {
  eventKeyPrefix: string;
  queueKeyPrefix: string;
  lockKeyPrefix: string;
  awaiterKeyPrefix: string;
  channelPrefix: string;
  aclKeyPattern: string;
  aclChannelPattern: string;
  aclUsername: string;
}

/**
 * `q` only: the scoped Redis account a participant's game Lambda logs in with.
 * `password` exists on issue and nowhere else — it is never stored in plaintext,
 * so "lost it" always means "issue again".
 */
export interface ChannelRedisUser {
  channelId: string;
  host: string;
  port: number;
  username: string;
  eventKeyPrefix: string;
  queueKeyPrefix: string;
  lockKeyPrefix: string;
  awaiterKeyPrefix: string;
  channelPrefix: string;
  /** Present on read only; absent when the stage has no issuer to ask. */
  issued?: boolean;
  /** Present on read only. `false` = this stage cannot issue at all. */
  configured?: boolean;
  /** Present on issue only, once. */
  password?: string;
  /**
   * Present on issue, and only when `false`: the account is live but missing
   * from Redis' ACL file, so it dies at the next restart.
   */
  persisted?: boolean;
}

/**
 * `auth` only: the server credential for the state service. `apiKey` exists on
 * issue and nowhere else — the console shows it once and never reads it back.
 */
export interface ChannelDocKey {
  channelId: string;
  docUrl: string;
  writePath: string;
  /** Where the same key reads and writes a project's kv collections. */
  kvPath: string;
  issued: boolean;
  /** Absent when the console has no handle on the document table — unknown, not zero. */
  documents?: number;
  /**
   * Social profiles of this channel; absent means unknown, not zero. There is
   * deliberately no relation count — an unbounded `COUNT(*)` has no place on a
   * read that backs a page.
   */
  profiles?: number;
  /** Present on read and only when `false`: this stage has no state stack. */
  configured?: boolean;
  /** Present on issue only, once. */
  apiKey?: string;
}

export type PushSender = "platform" | "team";

/**
 * A push channel's config as the API returns it. `packageName` and `sender`
 * are fixed at creation; the team's service-account key is write-only.
 */
export interface PushConfig {
  authChannelId: string;
  packageName: string;
  sender: PushSender;
}

/** One Firebase project of the stage's pool, named by its label only. */
export interface PushPoolSlot {
  slot: string;
  /** `false`: rows still name the slot, but the stage no longer provisions it. */
  provisioned: boolean;
  closed: boolean;
  /** A member id, or `auto:…` when the platform closed it on its own. */
  closedBy: string | null;
  closedByLogin: string | null;
  closedAt: number | null;
  apps: number;
  capacity: number;
}

/** `GET /admin/push/pool`. */
export interface PushPoolView {
  /** `false`: no Firebase project is provisioned on this stage. */
  configured: boolean;
  slots: PushPoolSlot[];
}

export interface Channel extends ResourceCrumbs {
  id: string;
  kind: ChannelKind;
  name: string;
  config:
    AuthConfig | TopicConfig | MatchConfig | LobbyConfig | QConfig | PushConfig;
  createdAt: number;
  expiresAt: number;
  disabledAt: number | null;
  status: ChannelStatus;
  // auth
  issuer?: string;
  /** Whether player ids are salted; `false` on a channel older than the salt. */
  saltedIds?: boolean;
  startUrl?: string;
  callbackUrls?: Record<string, string>;
  /** Absent when the state stack is not deployed on this stage. */
  docUrl?: string;
  // topic; push (the state stack's base, absent while it is not deployed);
  // deferred match (the match stack's HTTP host, absent while it has none)
  apiBase?: string;
  // topic / live match / lobby / q
  wsUrl?: string;
  // deferred match, instead of `wsUrl`
  ticketUrl?: string;
  // q
  redis?: GatewayRedis;
  // push
  /** The platform registration exists: `google-services.json` can be downloaded. */
  registered?: boolean;
  /** The team's own Firebase project, once a team sender key is registered. */
  teamProject?: string;
  // shown once on create / rotate
  secret?: string;
  apiKey?: string;
}

// ---- events -----------------------------------------------------------------

export interface EventSummary {
  id: string;
  title: string;
  status: EventStatus;
  place: string;
  durationHours: number;
  voteUntil: number;
  startsAt: number | null;
  owner: string | null;
  mine: boolean;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  hasPoster: boolean;
}

export interface EventOption {
  id: string;
  startsAt: number;
  mine: boolean;
  /** Present once the vote has closed. */
  votes?: number;
}

export interface EventDetail {
  id: string;
  title: string;
  status: EventStatus;
  bodyMd: string;
  place: string;
  placeUrl: string | null;
  durationHours: number;
  voteUntil: number;
  startsAt: number | null;
  options: EventOption[];
  voters?: number;
  owner: string | null;
  mine: boolean;
  canEdit: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  cancelledAt: number | null;
  cancelledBy: string | null;
  /**
   * Non-null when a platform admin ended the vote before its deadline
   * (`docs/decisions.md` *Hackathon workflow*, early close). Shown on the page
   * so participants see a forced decision, not only the audit log.
   */
  voteClosedAt: number | null;
  voteClosedBy: string | null;
  voteClosedReason: string | null;
  /**
   * Present only alongside `voteClosedAt`: true when the admin also named a
   * date the tally would not have picked. An early close usually lets the
   * standing rule decide, so the two cases must read differently.
   */
  voteOverridden?: boolean;
  posterUrl: string | null;
  /** The gallery this event spawned, if any (`docs/decisions.md` decision 11). */
  showId: string | null;
  comments: Comment[];
}

/** Body of `POST /events`; `PATCH` takes any subset. */
export interface EventInput {
  title: string;
  bodyMd: string;
  place: string;
  placeUrl: string | null;
  durationHours: number;
  voteUntil: number;
  options: number[];
}

export interface EventRevision {
  revision: number;
  editedBy: string | null;
  editedAt: number;
  title: string;
  place: string;
  placeUrl: string | null;
  durationHours: number;
  posterKey: string | null;
  /** Only on `GET /events/{id}/revisions/{n}`. */
  bodyMd?: string;
}

export interface EventPoster {
  id: string;
  key: string;
  contentType: string;
  size: number;
  uploadedBy: string | null;
  uploadedAt: number;
  replacedAt: number | null;
  deletedAt: number | null;
  current: boolean;
}

export interface PosterUpload {
  key: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresInSec: number;
}

// ---- binary catalog --------------------------------------------------------

export const CATALOG_PLATFORMS = [
  "android",
  "ios",
  "bin",
  "server",
  "win32",
  "osx",
  "linux",
] as const;
export type CatalogPlatform = (typeof CATALOG_PLATFORMS)[number];

export interface CatalogApp extends ResourceCrumbs {
  id: string;
  name: string;
  path: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CatalogSettings {
  slackHookUrl: string | null;
  slackChannel: string | null;
  messageTemplate: string | null;
  keepRecentVersions: number;
}

export interface CatalogArtifact {
  id: string;
  appId: string;
  platform: CatalogPlatform;
  url: string;
  objectKey: string | null;
  size: number | null;
  hash: string | null;
  tags: Record<string, string>;
  createdAt: number;
  ios?: { manifestUrl: string; installUrl: string };
}

/** The commit's answer: the artifact plus the project version it was linked to. */
export interface CatalogArtifactCommit extends CatalogArtifact {
  version: {
    id: string;
    name: string;
    linkId: string;
    created: boolean;
  } | null;
}

// ---- catalog listings (docs/decisions.md *Catalog listings*) ---------------

export const LISTING_AUDIENCES = ["public", "members"] as const;
export type ListingAudience = (typeof LISTING_AUDIENCES)[number];
export const LISTING_SORT_KEYS = ["publishedAt", "title"] as const;
/** Lowercase slugs, 1–32 chars, at most 10 per listing (decision #6). */
export const LISTING_TAG = /^[a-z0-9-]{1,32}$/;
export const LISTING_TAGS_MAX = 10;

/** The team's (and the admin's) view of how an app is published. */
export interface CatalogListing {
  appId: string;
  appName: string;
  teamId: string;
  teamName: string | null;
  title: string;
  summary: string | null;
  tags: string[];
  audience: ListingAudience;
  publishedBy: string | null;
  publishedAt: number;
  updatedAt: number;
  /** A platform admin hid it; the team may edit or unpublish, not republish. */
  takenDown: boolean;
}

export interface CatalogListingTakedown {
  by: string | null;
  at: number;
  reason: string | null;
}

/**
 * The admin list's row (decision #8): the team's view plus who took it down
 * and why, plus the same builds as the public row — the one browse page
 * shows an admin every listing with the download column everyone sees.
 */
export interface AdminCatalogListing
  extends
    CatalogListing,
    Pick<PublicListing, "artifacts" | "latestArtifact" | "applicationIds"> {
  takedown: CatalogListingTakedown | null;
}

export interface CatalogListingViewer {
  login: string | null;
  addedBy: string | null;
  addedAt: number;
}

/** A row of the public browse list: names and CDN links, never a storage key. */
export interface PublicListing {
  appId: string;
  appName: string;
  teamName: string | null;
  title: string;
  summary: string | null;
  tags: string[];
  audience: ListingAudience;
  publishedAt: number;
  updatedAt: number;
  /** The newest artifact per platform, newest first. */
  artifacts: Omit<CatalogArtifact, "objectKey">[];
  latestArtifact: Omit<CatalogArtifact, "objectKey"> | null;
  applicationIds: string[];
}

/**
 * What the browse page renders: the public row, or the admin's superset of
 * it. `takenDown` set (even `false`) marks an admin row; the admin-only ids
 * (`teamId`, `publishedBy`) are left out so the shared page cannot render
 * them by accident.
 */
export type BrowseListing = PublicListing &
  Partial<Pick<AdminCatalogListing, "takenDown" | "takedown">>;

export interface ListingListParams extends ListParams {
  tag?: string;
  platform?: CatalogPlatform;
}

export interface CatalogUploadGrant {
  uploadId: string;
  key: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: number;
}

export interface CatalogCleanupPreview {
  keepRecentVersions: number;
  totalArtifacts: number;
  deletions: Array<{
    artifactId: string;
    platform: string;
    version: string;
    reason: "old_version" | "duplicate_variant";
    createdAt: number;
  }>;
}

export interface CatalogCleanupResult {
  dryRun?: boolean;
  executed?: boolean;
  preview: CatalogCleanupPreview;
  deleted?: number;
  s3Failures?: number;
}

export interface InstallerDownload {
  url: string;
  filename: string;
  platform: CatalogPlatform;
  version: string | null;
  createdAt: number;
}

// ---- assets ----------------------------------------------------------------

export interface AssetVersion {
  version: string;
  files: number;
  bytes: number;
  createdAt: number;
}

/**
 * Fixed at creation (docs/decisions.md *Live and encrypted asset bundles*):
 * `versioned` keys every file under a version, `live` is one namespace that
 * `yyt asset sync` keeps up to date.
 */
export type AssetBundleMode = "versioned" | "live";

export interface AssetBundle extends ResourceCrumbs {
  id: string;
  name: string;
  description: string | null;
  mode: AssetBundleMode;
  /** Every object is `yyt-enc v1` ciphertext; the console holds the key. */
  encrypted: boolean;
  createdAt: number;
  updatedAt: number;
}

/** `POST /assets/bundles/{b}/key`: the bundle key in its `yak1.` text form. */
export interface AssetBundleKey {
  bundleId: string;
  key: string;
  format: "yyt-enc-v1";
}

export interface AssetBundleDetail extends AssetBundle {
  /** Always empty for a live bundle. */
  versions: AssetVersion[];
  /** Files over every version; `versions[].files` counts one version. */
  files: number;
  bytes: number;
}

/** One page of a version's files, `path` order; `next` is the last path. */
export interface AssetFilePage {
  bundleId: string;
  version: string;
  files: AssetFile[];
  next: string | null;
}

/** `GET /assets/bundles/{b}/files` of a live bundle: no version. */
export interface AssetLiveFilePage {
  bundleId: string;
  mode: "live";
  version: null;
  files: AssetFile[];
  next: string | null;
}

/** `DELETE /assets/bundles/{b}/files`: what happened to each path asked for. */
export interface AssetFileDeleteResult {
  deleted: string[];
  /** Not in the bundle. */
  missing: string[];
  /** Not stale, with `stale: true`. */
  skipped: string[];
  /** The object delete failed; the row stays, delete again. */
  failed: string[];
}

/** A bundle or version delete that ran out of time answers 202 with this. */
export interface AssetDeleteProgress {
  done: false;
  deleted: number;
  failed: number;
}

/** `GET /assets/bundles/{b}/versions/{v}`: the page plus the bundle's name. */
export interface AssetVersionPage extends AssetFilePage {
  bundle: string;
}

export interface CursorPage {
  cursor?: string;
  limit?: number;
}

export interface AssetFile {
  id: string;
  bundleId: string;
  version: string;
  path: string;
  url: string;
  objectKey: string;
  contentType: string;
  size: number;
  hash: string | null;
  /** Hex SHA-256; always set in a live bundle. */
  sha256: string | null;
  /** Live bundles only: served `no-cache`, replaced by the next sync. */
  mutable: boolean;
  /** When a sync found it missing locally; `--prune` deletes it next time. */
  staleSince: number | null;
  createdAt: number;
}

// ---- static sites -----------------------------------------------------------

export type SiteDeployStatus =
  "pending" | "queued" | "extracting" | "live" | "failed";

/** `move` is a rename (docs/decisions.md *Site domains* §2): no zip. */
export type SiteDeployKind = "upload" | "move";

export interface SiteDeploy {
  id: string;
  siteId: string;
  status: SiteDeployStatus;
  zipBytes: number;
  bytes: number;
  files: number;
  /** Fixed machine code on `failed` (`zip_no_index_html`, `worker_lost`, …). */
  error: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  /** Absent from an API without site names: read as `upload`. */
  kind?: SiteDeployKind;
  /** The prefix a move copies to (a claimed name or a fresh random slug). */
  moveTo?: string | null;
  moveFrom?: string | null;
}

export interface Site extends ResourceCrumbs {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  /** The path URL (`https://g.yyt.life/{slug}/`); follows the slug. */
  publicUrl: string;
  basePath: string;
  /*
   * Site names (docs/decisions.md *Site domains* §10). Optional so a view
   * from an API without them still renders; `null` is the API's own answer.
   */
  /** The claimed name, or null while the slug is random. */
  domain?: string | null;
  /** `https://{slug}.{hostSuffix}/`, null on a stage without the per-site host. */
  hostUrl?: string | null;
  /** `dev-g.yyt.life` / `g.yyt.life`, null on a stage without the per-site host. */
  hostSuffix?: string | null;
  /** The target of a move in flight (the site is `busy` meanwhile). */
  movingTo?: string | null;
  currentDeployId: string | null;
  /** A deploy, a move or a delete holds the site; a new deploy is refused meanwhile. */
  busy: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SiteDetail extends Site {
  currentDeploy: SiteDeploy | null;
  deploys: SiteDeploy[];
  warning: string;
}

/** Platform admin: one row of the site-name ledger (`GET /admin/site-names/{name}`). */
export interface SiteNameRecord {
  name: string;
  /** Null for a deleted team's name or a prefix nobody recorded. */
  teamId: string | null;
  /** `name` = claimed by a team; `slug` = a random slug a site gave up or moved to. */
  kind: "name" | "slug";
  createdBy: string | null;
  createdAt: number;
  /** Null while a site uses it (or a move to it is in flight). */
  releasedAt: number | null;
  /** The prefix served files: kept for its team for good. */
  served: boolean;
  purgedAt: number | null;
}

export interface SiteDeployGrant {
  deployId: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: number;
}

export interface AssetUploadGrant {
  uploadId: string;
  key: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: number;
  /**
   * A file over the single-PUT ceiling (64 MiB) is granted parts instead of
   * a URL; the browser does not upload those (`yyt asset sync` does).
   */
  multipart?: boolean;
  partSize?: number;
  partCount?: number;
}

/* ---- show (the gallery) --------------------------------------------------- */

export type ShowAcl = "public" | "member_only";
export type ShowTargetKind = "app" | "bundle" | "site";

export interface ShowSummary {
  id: string;
  title: string;
  acl: ShowAcl;
  eventId: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface ShowGrant {
  login: string | null;
  grantedBy: string | null;
  grantedAt: number;
}

export interface ShowDetail extends ShowSummary {
  bodyMd: string;
  closedBy: string | null;
  entryCount: number;
  canWrite: boolean;
  canManage: boolean;
  /** Owner and admins only. */
  grants?: ShowGrant[];
}

export interface ShowTarget {
  kind: ShowTargetKind;
  id: string;
  /** Snapshotted at submit time: the resource itself may be gone. */
  name: string;
  /** The pinned artifact (app) or version (bundle); a site links live. */
  ref: string | null;
  available: boolean;
  url: string | null;
}

export interface ShowShot {
  id: string;
  contentType: string;
  size: number;
  /** The API redirect, never the object key: visibility follows the show's. */
  url: string;
}

export interface ShowEntry {
  id: string;
  showId: string;
  title: string;
  bodyMd: string;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  target: ShowTarget;
  shots: ShowShot[];
  likes: number;
  /**
   * A count, not the thread: the detail route carries the thread under
   * `comments`, and one field must not be two types on sibling endpoints.
   */
  commentCount: number;
  liked: boolean;
}

/** The card's fields plus the comment thread the detail route embeds. */
export interface ShowEntryDetail extends ShowEntry {
  comments: Comment[];
  /** Show-level: may this caller put anything on this wall at all. */
  canWrite: boolean;
  /** Entry-level, and a different ladder: author, show owner or admin. */
  canEdit: boolean;
  /** Moderating somebody else's content here needs a stated reason. */
  canModerate: boolean;
  canReact: boolean;
}

export interface ShowSubmittable {
  kind: ShowTargetKind;
  id: string;
  name: string;
}

/** One presigned PUT. The object key is server-minted and never sent here. */
export interface ShotGrant {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
}

export interface ShotUpload {
  grants: ShotGrant[];
  expiresInSec: number;
}

export interface AuditRow {
  id: string;
  actor: string | null;
  action: string;
  target: string | null;
  at: number;
}

export interface AuditDetail extends AuditRow {
  detail: string | null;
  detailTruncated: boolean;
}

export interface AuditFilter {
  action?: string;
  actionPrefix?: string;
  target?: string;
  actor?: string;
  from?: number;
  to?: number;
  cursor?: string;
  limit?: number;
}

/* ---- list ordering and search (docs/decisions.md *List sort and filter*) ---- */

export type SortOrder = "asc" | "desc";

/**
 * What a list route accepts: `sort` is one of the response's field names,
 * `order` defaults to `asc`, `q` is a case-insensitive contains where the
 * route offers it. Empty values are dropped by the client's `qs`.
 */
export interface ListParams {
  sort?: string;
  order?: SortOrder;
  q?: string;
}

// ---- key-value store (`kv`) ----------------------------------------------

export type KvScope = "team" | "server" | "project" | "user";
/** Declaration order is the server's sort order (`KV_SCOPES` in console-db). */
export const KV_SCOPES: readonly KvScope[] = [
  "team",
  "server",
  "project",
  "user",
];

/** One row of `GET /projects/{prj}/kv`; `entries` is the live count. */
export interface KvCollection extends ResourceCrumbs {
  id: string;
  name: string;
  readScope: KvScope;
  writeScope: KvScope;
  encrypted: boolean;
  maxEntries: number;
  maxEntriesPerOwner: number;
  entries: number;
  createdAt: number;
  updatedAt: number;
}

/** Where a game reads and writes this collection through the KV API. */
export interface KvApi {
  /** `false` on a stage without the state stack: the paths are still shown. */
  configured: boolean;
  baseUrl: string;
  metaPath: string;
  /** The same collection addressed by its (URL-encoded) name. */
  namePath: string;
  entriesPath: string;
  /** Only when `writeScope` is `user`: one namespace per owner. */
  ownerPath?: string;
}

export interface KvCollectionDetail extends KvCollection {
  description: string | null;
  api: KvApi;
}

/** What create and update answer: the row and the api block, no live count. */
export type KvCollectionWrite = Omit<KvCollectionDetail, "entries">;

export interface KvEntry {
  /** Only in a per-owner namespace (either scope is `user`). */
  owner?: string;
  key: string;
  version: number;
  /** Plaintext bytes, also for an encrypted collection. */
  bytes: number;
  expiresAt: number | null;
  /** The auth channel whose credential wrote it; `null` for a console write. */
  channelId: string | null;
  /**
   * Who wrote the current value — an owner id, `server` or `team`. Per-owner
   * collections only, and absent on a row written before the stamp existed.
   */
  from?: string;
  updatedAt: number;
  /** The stored JSON text verbatim; absent when encrypted or for a seatless admin. */
  valueText?: string;
}

export interface KvEntryPage {
  entries: KvEntry[];
  nextCursor?: string;
}

export interface KvEntryQuery {
  prefix?: string;
  owner?: string;
  cursor?: string;
  limit?: number;
  order?: SortOrder;
}

export interface KvEntryPutInput {
  owner?: string;
  valueText: string;
  /** Seconds; `0` clears, omitted keeps. */
  ttl?: number;
  /** The version the caller read; a mismatch is a 409. */
  ifVersion?: number;
}

export interface KvEntryPutResult {
  owner?: string;
  key: string;
  version: number;
  bytes: number;
  created: boolean;
}

// ---- leaderboards (`lb`) --------------------------------------------------

/** Who may write a score. The doc apiKey may submit on either kind of board. */
export type LbSubmit = "server" | "owner";
/** How a new score meets the stored one. */
export type LbRule = "best" | "latest" | "sum";
/** Which end of the range ranks first; `asc` is for times. */
export type LbOrder = "desc" | "asc";
export type LbPeriod = "alltime" | "daily" | "weekly";

/** Declaration order is the server's sort order (`LB_*` in console-db). */
export const LB_SUBMITS: readonly LbSubmit[] = ["server", "owner"];
export const LB_RULES: readonly LbRule[] = ["best", "latest", "sum"];
export const LB_ORDERS: readonly LbOrder[] = ["desc", "asc"];
export const LB_PERIODS: readonly LbPeriod[] = ["alltime", "daily", "weekly"];

/** One row of `GET /projects/{prj}/leaderboards`. */
export interface Leaderboard extends ResourceCrumbs {
  id: string;
  name: string;
  submit: LbSubmit;
  rule: LbRule;
  order: LbOrder;
  /** Always non-empty, always in `LB_PERIODS` order. */
  periods: LbPeriod[];
  maxEntries: number;
  retainPeriods: number;
  createdAt: number;
  updatedAt: number;
}

/** Where a game reads and writes this board through the LB API. */
export interface LbApi {
  /** `false` on a stage without the state stack: the paths are still shown. */
  configured: boolean;
  baseUrl: string;
  metaPath: string;
  /** The same board addressed by its (URL-encoded) name. */
  namePath: string;
  topPath: string;
  /** `{ownerId}` is a placeholder, or the literal `me` for a player token. */
  scorePath: string;
}

export interface LeaderboardDetail extends Leaderboard {
  description: string | null;
  api: LbApi;
  /** The live bucket the detail counted, computed by the platform's clock. */
  period: LbPeriod;
  periodKey: string;
  /** Rows in that bucket. */
  scores: number;
}

/** What create and update answer: the row and the api block, no bucket count. */
export type LeaderboardWrite = Omit<
  LeaderboardDetail,
  "scores" | "period" | "periodKey"
>;

export interface LbScore {
  /** `1 + count(better)`, so equal scores share a rank. */
  rank: number;
  owner: string;
  score: number;
  /**
   * The stored JSON text verbatim; the platform never parses it. Absent for a
   * seatless platform admin — it is the team's own payload, like a kv value.
   */
  meta?: string | null;
  /** The auth channel whose credential wrote it. */
  channelId: string | null;
  updatedAt: number;
}

export interface LbScorePage {
  period: LbPeriod;
  periodKey: string;
  total: number;
  scores: LbScore[];
}

/** `GET /leaderboards/{id}/scores/{ownerId}`: one owner in one bucket. */
export interface LbOwnerScore extends LbScore {
  period: LbPeriod;
  periodKey: string;
  total: number;
}

export interface LbScoreQuery {
  /** A bucket by name (`alltime`) or by key (`2026-09-10`, `2026-W37`). */
  period?: string;
  limit?: number;
  offset?: number;
}

// ---- game kit config ------------------------------------------------------

/**
 * `GET /projects/{prj}/kit-config` (`docs/game-kit-design.md`). Every section
 * is optional: one whose stack the stage does not have, or whose channel the
 * project does not hold, is **absent** rather than empty, so a kit module with
 * no config fails on first use instead of connecting to nowhere.
 *
 * All public values — ids, names and hosts. There is no secret in it.
 */
export interface KitConfig {
  auth?: { url: string; channelId: string; provider?: string };
  state?: { url: string };
  gateway?: { url: string; lobbyChannelId: string };
  /**
   * A deferred match channel has no socket: its section names the ticket API
   * instead of a `url` (`docs/decisions.md` *Match: deferred mode*).
   */
  match?:
    | { url: string; channelId: string }
    | {
        mode: "deferred";
        apiBase: string;
        ticketUrl: string;
        channelId: string;
      };
  /** Absent, not empty, when the project has none — same rule as the sections above. */
  collections?: Record<string, string>;
  boards?: Record<string, string>;
}

// ---- limits (docs/decisions.md *Limit requests (soft/hard)*) --------------

export type LimitScopeKind =
  "project" | "bundle" | "channel" | "team" | "collection";
export type LimitUnit = "bytes" | "count" | "seconds";
/** `unlimited` exists only where the hard value is (`channel.lifetime`). */
export type LimitValue = number | "unlimited";
export type LimitRequestStatus =
  "pending" | "approved" | "rejected" | "cancelled";
export const LIMIT_REQUEST_STATUSES: readonly LimitRequestStatus[] = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
];

export interface LimitOverride {
  value: LimitValue;
  /** A temporary raise ends here; `null` = until revoked. */
  expiresAt: number | null;
  note: string;
  requestId: string | null;
  grantedBy: string;
  grantedByLogin: string | null;
  grantedAt: number;
}

/** One key of `GET /limits`: the registry row plus this scope's standing. */
export interface LimitRow {
  key: string;
  unit: LimitUnit;
  soft: number;
  hard: LimitValue;
  effective: LimitValue;
  /** `null` where nothing is counted (`channel.lifetime`). */
  usage: number | null;
  /**
   * A stepped key (`team.projects`) is asked for only as `effective + step`,
   * and only once the usage has reached the effective value: `next` is that
   * one value while it may be asked for, else `null`. Both `null` elsewhere.
   */
  step: number | null;
  next: number | null;
  override: LimitOverride | null;
}

export interface LimitRequest {
  id: string;
  teamId: string;
  teamName: string | null;
  scope: { kind: LimitScopeKind; id: string; name: string | null };
  key: string;
  /** The registry's unit and ceiling for `key`; `null` for a retired key. */
  unit: LimitUnit | null;
  hard: LimitValue | null;
  requestedValue: LimitValue;
  reason: string;
  status: LimitRequestStatus;
  /** What was granted; only on an approved request. */
  decidedValue: LimitValue | null;
  decisionNote: string | null;
  createdBy: string;
  createdByLogin: string | null;
  createdAt: number;
  decidedBy: string | null;
  decidedByLogin: string | null;
  decidedAt: number | null;
}

export interface LimitsView {
  scope: { kind: LimitScopeKind; id: string };
  teamId: string;
  /** Channel scope only: the channel's `expiresAt`. */
  expiresAt?: number;
  limits: LimitRow[];
  /** This scope's pending requests. */
  pending: LimitRequest[];
}

/** Body of `POST /limit-requests`; `scope` is `<kind>:<id>`. */
export interface LimitRequestInput {
  scope: string;
  key: string;
  value: LimitValue;
  reason: string;
}

export interface LimitRequestQuery extends CursorPage {
  status?: LimitRequestStatus;
}

export interface LimitRequestPage {
  requests: LimitRequest[];
  next: string | null;
}

/** The platform-wide list also counts what waits, for the menu badge. */
export interface AdminLimitRequestPage extends LimitRequestPage {
  pending: number;
  oldestPendingAt: number | null;
}

export interface LimitOverrideResult {
  scope: { kind: LimitScopeKind; id: string };
  key: string;
  effective: LimitValue;
  override: LimitOverride | null;
}
