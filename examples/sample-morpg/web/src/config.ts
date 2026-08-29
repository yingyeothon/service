/* What the page needs from the dev server (`web/vite.config.mjs`); a static build has none of it. */
export interface WebConfig {
  apiBase: string;
  gatewayWsUrl: string;
  state: { authChannelId: string; lobbyChannelId: string; qChannelId: string };
  user: string;
  /** The dev server can mint debug tokens (auth base + key file configured). */
  canMint: boolean;
}

const isNonEmpty = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

export function parseWebConfig(raw: unknown): WebConfig {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  const st = (
    typeof o.state === "object" && o.state !== null ? o.state : {}
  ) as Record<string, unknown>;
  for (const k of ["apiBase", "gatewayWsUrl"])
    if (!isNonEmpty(o[k])) throw new Error(`config lacks ${k}`);
  for (const k of ["authChannelId", "lobbyChannelId", "qChannelId"])
    if (!isNonEmpty(st[k])) throw new Error(`config.state lacks ${k}`);
  return {
    apiBase: o.apiBase as string,
    gatewayWsUrl: o.gatewayWsUrl as string,
    state: {
      authChannelId: st.authChannelId as string,
      lobbyChannelId: st.lobbyChannelId as string,
      qChannelId: st.qChannelId as string,
    },
    user: isNonEmpty(o.user) ? o.user : "player",
    canMint: o.canMint === true,
  };
}

/**
 * The dev server's `/__morpg/config` first; a static build (`pnpm web:build`)
 * ships without it and reads a `config.json` next to `index.html` instead
 * (same shape, no `canMint`), with the JWT pasted into the page.
 */
export async function loadWebConfig(): Promise<WebConfig> {
  for (const url of ["/__morpg/config", "./config.json"]) {
    const res = await fetch(url, { cache: "no-store" }).catch(() => undefined);
    if (res?.ok) return parseWebConfig(await res.json());
  }
  throw new Error("no /__morpg/config (dev server) and no config.json");
}

export async function mintToken(userId: string): Promise<string> {
  const res = await fetch("/__morpg/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  const body = (await res.json()) as { jwt?: unknown; error?: unknown };
  if (!res.ok || typeof body.jwt !== "string")
    throw new Error(
      `mint: ${typeof body.error === "string" ? body.error : res.status}`,
    );
  return body.jwt;
}
