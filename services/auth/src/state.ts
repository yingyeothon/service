import { AppError, randomHex, sha256Hex } from "@yyt/core";
import type { Kv } from "@yyt/redis";
import type { ProviderName } from "./providers/types.js";

export interface OAuthState {
  channelId: string;
  provider: ProviderName;
  redirect: string;
  /** sha256 of the browser-bound nonce cookie; ties the callback to the browser that started it. */
  nonceHash: string;
}

export interface StateStore {
  issue(data: OAuthState): Promise<string>;
  /** Single-use: a second consume of the same state throws 400. */
  consume(state: string): Promise<OAuthState>;
}

export const STATE_TTL_SEC = 600;

/**
 * `auth:{stage}:state:{sha256(state)}` → JSON, TTL 10 minutes. Keyed by digest
 * because a key name is not covered by the ACL's key patterns: Redis does not
 * filter `SCAN` by them, so every account on the shared instance can list key
 * names even when refused every read.
 */
export function createStateStore(kv: Kv): StateStore {
  const key = (s: string) => `state:${sha256Hex(s)}`;
  return {
    issue: async (data) => {
      const state = randomHex(24);
      await kv.set(key(state), JSON.stringify(data), {
        nx: true,
        ex: STATE_TTL_SEC,
      });
      return state;
    },
    consume: async (state) => {
      if (!/^[0-9a-f]{48}$/.test(state))
        throw new AppError("bad_request", "invalid state");
      const raw = await kv.get(key(state));
      // `del` tells us whether we were the one to remove it; a concurrent
      // consumer racing on the same state loses here.
      const removed = raw === null ? 0 : await kv.del(key(state));
      if (raw === null || removed === 0)
        throw new AppError("bad_request", "state expired or already used");
      return JSON.parse(raw) as OAuthState;
    },
  };
}
