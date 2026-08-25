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
}

export interface Channel {
  id: string;
  kind: ChannelKind;
  name: string;
  ownerId: string;
  config: AuthConfig | TopicConfig | MatchConfig | LobbyConfig | QConfig;
  createdAt: number;
  expiresAt: number;
  disabledAt: number | null;
  status: ChannelStatus;
  // auth
  issuer?: string;
  startUrl?: string;
  callbackUrls?: Record<string, string>;
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
export type CatalogPermissionLevel = "read" | "edit";

export interface CatalogGroup {
  id: string;
  name: string;
  ownerLogin: string | null;
  pendingOwnerLogin: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CatalogApp {
  id: string;
  name: string;
  path: string;
  debugOnly: boolean;
  description: string | null;
  groupId: string | null;
  ownerLogin: string | null;
  pendingOwnerLogin: string | null;
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

export interface CatalogPermission {
  id: string;
  login: string | null;
  pending: boolean;
  level: CatalogPermissionLevel;
  createdAt: number;
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

export interface AssetVersion {
  version: string;
  files: number;
  bytes: number;
  createdAt: number;
}

export interface AssetBundle {
  id: string;
  name: string;
  description: string | null;
  ownerLogin: string | null;
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
