export type Role = "admin" | "member" | "pending";
export type ChannelKind = "auth" | "topic" | "match";
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

export interface Channel {
  id: string;
  kind: ChannelKind;
  name: string;
  ownerId: string;
  config: AuthConfig | TopicConfig | MatchConfig;
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
  // topic / match
  wsUrl?: string;
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
