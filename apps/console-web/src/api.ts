import type {
  ApiToken,
  Channel,
  ChannelKind,
  EventDetail,
  EventStatus,
  EventSummary,
  Me,
  Member,
  PosterUpload,
  Proposal,
} from "./types";

/** Error body shape of `@yyt/http`: `{ error: { code, message, details? } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  /** `""` = same origin; the session cookie is `__Host-`, so the API must be same-origin (the dev server proxies it). */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Called on any 401 outside `me()`: the session expired mid-use. */
  onUnauthorized?: () => void;
}

async function parseError(res: Response): Promise<ApiError> {
  let code = "http_error";
  let message = `${res.status} ${res.statusText}`.trim();
  let details: unknown;
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    if (body.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      details = body.error.details;
    }
  } catch {
    // non-JSON body (gateway HTML etc.)
  }
  return new ApiError(res.status, code, message, details);
}

export function createApiClient({
  baseUrl = "",
  fetch: fetchImpl = (...a) => fetch(...a),
  onUnauthorized,
}: ApiClientOptions = {}) {
  const base = baseUrl.replace(/\/+$/, "");
  let handler = onUnauthorized;

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await parseError(res);
      if (err.status === 401 && path !== "/me") handler?.();
      throw err;
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const get = <T>(path: string) => call<T>("GET", path);
  const post = <T>(path: string, body?: unknown) =>
    call<T>("POST", path, body ?? {});
  const patch = <T>(path: string, body: unknown) =>
    call<T>("PATCH", path, body);
  const put = <T>(path: string, body: unknown) => call<T>("PUT", path, body);
  const del = (path: string) => call<void>("DELETE", path);
  const enc = encodeURIComponent;

  return {
    /** Lets the auth provider react to a session that expired mid-use. */
    setUnauthorizedHandler(h: (() => void) | undefined) {
      handler = h;
    },
    /** `null` when not logged in. */
    async me(): Promise<Me | null> {
      try {
        return await get<Me>("/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    logout: () => post<void>("/logout"),
    loginUrl: (next: string) => `${base}/auth/github/start?next=${enc(next)}`,

    members: () =>
      get<{ members: Member[] }>("/members").then((r) => r.members),
    memberAction: (id: string, action: "approve" | "promote" | "demote") =>
      post<Pick<Member, "id" | "login" | "role">>(
        `/members/${enc(id)}/${action}`,
      ),

    tokens: () => get<{ tokens: ApiToken[] }>("/tokens").then((r) => r.tokens),
    createToken: (name: string) =>
      post<ApiToken & { token: string }>("/tokens", { name }),
    revokeToken: (id: string) => del(`/tokens/${enc(id)}`),

    channels: (opts: { kind?: ChannelKind; scope?: "mine" | "all" } = {}) => {
      const q = new URLSearchParams();
      if (opts.kind) q.set("kind", opts.kind);
      if (opts.scope) q.set("scope", opts.scope);
      const qs = q.toString();
      return get<{ channels: Channel[] }>(
        `/channels${qs ? `?${qs}` : ""}`,
      ).then((r) => r.channels);
    },
    channel: (id: string) => get<Channel>(`/channels/${enc(id)}`),
    createChannel: (body: {
      kind: ChannelKind;
      name: string;
      config: unknown;
    }) => post<Channel>("/channels", body),
    updateChannel: (id: string, body: { name?: string; config?: unknown }) =>
      patch<Channel>(`/channels/${enc(id)}`, body),
    extendChannel: (id: string) => post<Channel>(`/channels/${enc(id)}/extend`),
    rotateChannelSecret: (id: string) =>
      post<Channel>(`/channels/${enc(id)}/rotate-secret`),
    deleteChannel: (id: string) => del(`/channels/${enc(id)}`),

    events: () =>
      get<{ events: EventSummary[] }>("/events").then((r) => r.events),
    event: (id: string) => get<EventDetail>(`/events/${enc(id)}`),
    createEvent: (body: { title: string; bodyMd: string }) =>
      post<EventDetail>("/events", body),
    updateEvent: (id: string, body: { title?: string; bodyMd?: string }) =>
      patch<EventDetail>(`/events/${enc(id)}`, body),
    transitionEvent: (id: string, to: EventStatus) =>
      post<EventDetail>(`/events/${enc(id)}/transition`, { to }),
    decideEvent: (id: string, proposalId: string) =>
      post<EventDetail>(`/events/${enc(id)}/decide`, { proposalId }),
    proposals: (id: string) =>
      get<{ proposals: Proposal[]; myVote: string | null }>(
        `/events/${enc(id)}/proposals`,
      ),
    createProposal: (id: string, body: { title: string; bodyMd: string }) =>
      post<Proposal>(`/events/${enc(id)}/proposals`, body),
    updateProposal: (
      id: string,
      pid: string,
      body: { title?: string; bodyMd?: string },
    ) => patch<Proposal>(`/events/${enc(id)}/proposals/${enc(pid)}`, body),
    deleteProposal: (id: string, pid: string) =>
      del(`/events/${enc(id)}/proposals/${enc(pid)}`),
    vote: (id: string, proposalId: string) =>
      put<{ eventId: string; proposalId: string }>(`/events/${enc(id)}/vote`, {
        proposalId,
      }),
    unvote: (id: string) => del(`/events/${enc(id)}/vote`),

    /** presign → browser PUT to S3 → commit. Returns the refreshed event. */
    async uploadPoster(id: string, file: File): Promise<EventDetail> {
      const grant = await post<PosterUpload>(`/events/${enc(id)}/poster`, {
        contentType: file.type,
        size: file.size,
      });
      const res = await fetchImpl(grant.url, {
        method: grant.method,
        headers: grant.headers,
        body: file,
      });
      if (!res.ok)
        throw new ApiError(
          res.status,
          "upload_failed",
          `poster upload failed (${res.status})`,
        );
      return post<EventDetail>(`/events/${enc(id)}/poster/commit`, {
        key: grant.key,
      });
    },
    deletePoster: (id: string) => del(`/events/${enc(id)}/poster`),
    /**
     * Poster `<img>` source. The API's `posterUrl` is absolute to the API host;
     * building it from our own base keeps the request same-origin (cookie
     * attached), which matters when the dev server proxies the API.
     */
    posterSrc: (id: string) => `${base}/events/${enc(id)}/poster`,
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

export const api: ApiClient = createApiClient();
