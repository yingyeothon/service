export type Role = "admin" | "member" | "pending";
export type ChannelKind = "auth" | "topic" | "match" | "lobby" | "q";
/** Kinds served by the self-hosted realtime gateway; neither carries a secret. */
export const GATEWAY_KINDS = ["lobby", "q"] as const;
export type ChannelStatus = "active" | "expired" | "disabled";
export type EventStatus =
  "draft" | "proposing" | "voting" | "decided" | "published" | "closed";

export const EVENT_STATUSES: readonly EventStatus[] = [
  "draft",
  "proposing",
  "voting",
  "decided",
  "published",
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
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  hasPoster: boolean;
}

export interface Proposal {
  id: string;
  eventId: string;
  memberLogin: string | null;
  title: string;
  bodyMd: string;
  createdAt: number;
  updatedAt: number;
  mine: boolean;
  votes?: number;
}

export interface EventDetail {
  id: string;
  title: string;
  status: EventStatus;
  bodyMd: string;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  winner: Proposal | null;
  posterUrl: string | null;
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
  "web",
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

export interface AssetUploadGrant {
  uploadId: string;
  key: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: number;
}
