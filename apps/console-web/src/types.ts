export type Role = "admin" | "member" | "pending";
export type ChannelKind = "auth" | "topic" | "match" | "lobby" | "q";
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

export interface RemoveMemberResult {
  removed: string;
  action: "leave" | "kick";
  rotate: RotationHint[];
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

export interface Discussion {
  id: string;
  teamId: string;
  title: string;
  bodyMd: string;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  mine: boolean;
}

export interface DiscussionDetail extends Discussion {
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
}

export interface VersionDetail extends Version {
  links: VersionLink[];
}

export type VersionLinkInput =
  | { kind: "artifact"; artifactId: string }
  | { kind: "asset_version"; bundleId: string; assetVersion: string };

export type IssueStatus = "open" | "closed";

export interface Issue {
  id: string;
  projectId: string;
  number: number;
  title: string;
  bodyMd: string;
  status: IssueStatus;
  versionId: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface IssueDetail extends Issue {
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

export interface AuthConfig {
  audience: string;
  tokenTtlSec: number;
  redirectAllowlist: string[];
  providers: { github?: { clientId: string }; google?: { clientId: string } };
}
export interface TopicConfig {
  authChannelId: string;
}
export interface MatchConfig {
  authChannelId: string;
  partySize: number;
  waitTimeoutSec: number;
  onTimeout: "partial" | "fail";
  callbackUrl: string;
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
  aoi?: { range: number; maxPeers: number };
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
  issued: boolean;
  /** Absent when the console has no handle on the document table — unknown, not zero. */
  documents?: number;
  /** Present on read and only when `false`: this stage has no state stack. */
  configured?: boolean;
  /** Present on issue only, once. */
  apiKey?: string;
}

export interface Channel extends ResourceCrumbs {
  id: string;
  kind: ChannelKind;
  name: string;
  config: AuthConfig | TopicConfig | MatchConfig | LobbyConfig | QConfig;
  createdAt: number;
  expiresAt: number;
  disabledAt: number | null;
  status: ChannelStatus;
  // auth
  issuer?: string;
  startUrl?: string;
  callbackUrls?: Record<string, string>;
  /** Absent when the state stack is not deployed on this stage. */
  docUrl?: string;
  // topic
  apiBase?: string;
  // topic / match / lobby / q
  wsUrl?: string;
  // q
  redis?: GatewayRedis;
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

export interface AssetBundle extends ResourceCrumbs {
  id: string;
  name: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AssetBundleDetail extends AssetBundle {
  versions: AssetVersion[];
  bytes: number;
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
  createdAt: number;
}

// ---- static sites -----------------------------------------------------------

export type SiteDeployStatus =
  "pending" | "queued" | "extracting" | "live" | "failed";

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
}

export interface Site extends ResourceCrumbs {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  publicUrl: string;
  basePath: string;
  currentDeployId: string | null;
  /** A deploy or a delete holds the site; a new deploy is refused meanwhile. */
  busy: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SiteDetail extends Site {
  currentDeploy: SiteDeploy | null;
  deploys: SiteDeploy[];
  warning: string;
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
