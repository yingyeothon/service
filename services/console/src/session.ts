import { AppError, randomHex, sha256Hex } from "@yyt/core";
import type { Kv } from "@yyt/redis";

export const SESSION_TTL_SEC = 7 * 86400;
export const OAUTH_STATE_TTL_SEC = 600;
/** `__Host-`: secure, host-only, path `/` — the SPA must be served from the same host (or proxied). */
export const SESSION_COOKIE = "__Host-yyt_console_sess";
export const NONCE_COOKIE = "__Host-yyt_console_nonce";

export interface SessionData {
  memberId: string;
  createdAt: number;
}

export interface OAuthStateData {
  nonceHash: string;
  /** SPA path to land on after login; must be a path, never an absolute URL. */
  next: string;
}

export interface SessionStore {
  /** Returns the opaque session id (the cookie value). Only its hash is stored. */
  create(data: SessionData): Promise<string>;
  get(sessionId: string): Promise<SessionData | undefined>;
  destroy(sessionId: string): Promise<void>;
  issueState(data: OAuthStateData): Promise<string>;
  /** Single-use. */
  consumeState(state: string): Promise<OAuthStateData>;
}

const SESSION_ID = /^[0-9a-f]{64}$/;
const STATE = /^[0-9a-f]{48}$/;

/** `console:{stage}:sess:{sha256(id)}` (7d) and `console:{stage}:oauth:{state}` (10m). */
export function createSessionStore(kv: Kv): SessionStore {
  const sessKey = (id: string) => `sess:${sha256Hex(id)}`;
  const stateKey = (s: string) => `oauth:${s}`;
  return {
    create: async (data) => {
      const id = randomHex(32);
      await kv.set(sessKey(id), JSON.stringify(data), {
        nx: true,
        ex: SESSION_TTL_SEC,
      });
      return id;
    },
    get: async (id) => {
      if (!SESSION_ID.test(id)) return undefined;
      const raw = await kv.get(sessKey(id));
      return raw === null ? undefined : (JSON.parse(raw) as SessionData);
    },
    destroy: async (id) => {
      if (SESSION_ID.test(id)) await kv.del(sessKey(id));
    },
    issueState: async (data) => {
      const state = randomHex(24);
      await kv.set(stateKey(state), JSON.stringify(data), {
        nx: true,
        ex: OAUTH_STATE_TTL_SEC,
      });
      return state;
    },
    consumeState: async (state) => {
      if (!STATE.test(state))
        throw new AppError("bad_request", "invalid state");
      const raw = await kv.get(stateKey(state));
      const removed = raw === null ? 0 : await kv.del(stateKey(state));
      if (raw === null || removed === 0)
        throw new AppError("bad_request", "state expired or already used");
      return JSON.parse(raw) as OAuthStateData;
    },
  };
}
