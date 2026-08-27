/*
 * Doc store client (services/state README): one versioned JSON document per
 * owner, every write conditional on the version read. The apiKey is the game
 * server's credential; clients only ever read their own row with their JWT.
 */

export interface DocRead<T = unknown> {
  doc: T;
  version: number;
}

export type DocWrite =
  { ok: true; version: number } | { ok: false; conflict: number | null };

export interface DocClient {
  read: (ownerId: string) => Promise<DocRead | undefined>;
  /** `version` 0 creates. */
  write: (ownerId: string, doc: unknown, version: number) => Promise<DocWrite>;
}

/** The doc store's owner grammar: a player's 32-hex `sub`, or `{kind}:{id}`. */
export const OWNER_ID = /^(?:[0-9a-f]{32}|[a-z]{1,8}:[A-Za-z0-9_-]{1,48})$/;

function ownerPath(base: string, ownerId: string): string {
  // The apiKey is privileged: never let an odd `sub` steer it to another path.
  if (!OWNER_ID.test(ownerId)) throw new Error("invalid ownerId");
  return `${base}/s/${ownerId}`;
}

export function parseEtag(etag: string | null): number {
  const m = /^(?:W\/)?"?(\d+)"?$/.exec(etag ?? "");
  return m ? Number(m[1]) : 0;
}

export function createDocClient({
  baseUrl,
  apiKey,
  fetchImpl = fetch,
  timeoutMillis = 3000,
}: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMillis?: number;
}): DocClient {
  const base = baseUrl.replace(/\/$/, "");
  const auth = { authorization: `Bearer ${apiKey}` };
  return {
    read: async (ownerId) => {
      const res = await fetchImpl(ownerPath(base, ownerId), {
        headers: auth,
        signal: AbortSignal.timeout(timeoutMillis),
      });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`doc read ${res.status}`);
      const etag = res.headers.get("etag");
      // A read without a version cannot be written back safely.
      if (etag === null || !/\d/.test(etag))
        throw new Error("doc read: no ETag");
      return { doc: await res.json(), version: parseEtag(etag) };
    },
    write: async (ownerId, doc, version) => {
      const res = await fetchImpl(ownerPath(base, ownerId), {
        method: "PUT",
        headers: {
          ...auth,
          "content-type": "application/json",
          "if-match": `"${version}"`,
        },
        body: JSON.stringify(doc),
        signal: AbortSignal.timeout(timeoutMillis),
      });
      if (res.status === 201 || res.status === 204)
        return { ok: true, version: parseEtag(res.headers.get("etag")) };
      if (res.status === 409) {
        const etag = res.headers.get("etag");
        return { ok: false, conflict: etag === null ? null : parseEtag(etag) };
      }
      throw new Error(`doc write ${res.status}`);
    },
  };
}
