import type {
  ApiToken,
  AssetBundle,
  AssetBundleDetail,
  AssetFile,
  AssetUploadGrant,
  CatalogApp,
  CatalogArtifact,
  CatalogCleanupResult,
  CatalogGroup,
  CatalogPermission,
  CatalogPermissionLevel,
  CatalogPlatform,
  CatalogSettings,
  CatalogUploadGrant,
  Channel,
  ChannelKind,
  ChannelDocKey,
  ChannelRedisUser,
  EventDetail,
  EventStatus,
  EventSummary,
  InstallerDownload,
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
  const del = <T = void>(path: string) => call<T>("DELETE", path);
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
    channelRedisUser: (id: string) =>
      get<ChannelRedisUser>(`/channels/${enc(id)}/redis-user`),
    issueChannelRedisUser: (id: string) =>
      post<ChannelRedisUser>(`/channels/${enc(id)}/redis-user`),
    revokeChannelRedisUser: (id: string) =>
      del<{ revoked: boolean }>(`/channels/${enc(id)}/redis-user`),
    channelDocKey: (id: string) =>
      get<ChannelDocKey>(`/channels/${enc(id)}/doc-key`),
    issueChannelDocKey: (id: string) =>
      post<ChannelDocKey>(`/channels/${enc(id)}/doc-key`),
    revokeChannelDocKey: (id: string) =>
      del<{ revoked: boolean }>(`/channels/${enc(id)}/doc-key`),

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

    // ---- binary catalog ---------------------------------------------------
    catalogGroups: () =>
      get<{ groups: CatalogGroup[] }>("/catalog/groups").then((r) => r.groups),
    catalogGroup: (id: string) =>
      get<CatalogGroup>(`/catalog/groups/${enc(id)}`),
    createCatalogGroup: (name: string) =>
      post<CatalogGroup>("/catalog/groups", { name }),
    updateCatalogGroup: (id: string, body: { name?: string }) =>
      patch<CatalogGroup>(`/catalog/groups/${enc(id)}`, body),
    deleteCatalogGroup: (id: string) => del(`/catalog/groups/${enc(id)}`),
    catalogGroupApps: (id: string) =>
      get<{ apps: CatalogApp[] }>(`/catalog/groups/${enc(id)}/apps`).then(
        (r) => r.apps,
      ),
    catalogGroupPermissions: (id: string) =>
      get<{ permissions: CatalogPermission[] }>(
        `/catalog/groups/${enc(id)}/permissions`,
      ).then((r) => r.permissions),
    grantCatalogGroupPermission: (
      id: string,
      login: string,
      level: CatalogPermissionLevel,
    ) =>
      post<{ permissions: CatalogPermission[] }>(
        `/catalog/groups/${enc(id)}/permissions`,
        { login, level },
      ).then((r) => r.permissions),
    revokeCatalogGroupPermission: (id: string, pid: string) =>
      del(`/catalog/groups/${enc(id)}/permissions/${enc(pid)}`),

    catalogApps: () =>
      get<{ apps: CatalogApp[] }>("/catalog/apps").then((r) => r.apps),
    catalogApp: (name: string) => get<CatalogApp>(`/catalog/apps/${enc(name)}`),
    createCatalogApp: (body: {
      name: string;
      path: string;
      description?: string;
      debugOnly?: boolean;
      groupId?: string;
    }) => post<CatalogApp>("/catalog/apps", body),
    updateCatalogApp: (
      name: string,
      body: {
        name?: string;
        path?: string;
        description?: string | null;
        debugOnly?: boolean;
        groupId?: string | null;
      },
    ) => patch<CatalogApp>(`/catalog/apps/${enc(name)}`, body),
    deleteCatalogApp: (name: string) => del(`/catalog/apps/${enc(name)}`),
    catalogSettings: (name: string) =>
      get<CatalogSettings>(`/catalog/apps/${enc(name)}/settings`),
    updateCatalogSettings: (name: string, body: Partial<CatalogSettings>) =>
      patch<CatalogSettings>(`/catalog/apps/${enc(name)}/settings`, body),
    catalogAppPermissions: (name: string) =>
      get<{ permissions: CatalogPermission[] }>(
        `/catalog/apps/${enc(name)}/permissions`,
      ).then((r) => r.permissions),
    grantCatalogAppPermission: (
      name: string,
      login: string,
      level: CatalogPermissionLevel,
    ) =>
      post<{ permissions: CatalogPermission[] }>(
        `/catalog/apps/${enc(name)}/permissions`,
        { login, level },
      ).then((r) => r.permissions),
    revokeCatalogAppPermission: (name: string, pid: string) =>
      del(`/catalog/apps/${enc(name)}/permissions/${enc(pid)}`),

    catalogArtifacts: (name: string) =>
      get<{ artifacts: CatalogArtifact[] }>(
        `/catalog/apps/${enc(name)}/artifacts`,
      ).then((r) => r.artifacts),
    deleteCatalogArtifact: (name: string, id: string) =>
      del(`/catalog/apps/${enc(name)}/artifacts/${enc(id)}`),
    cleanupCatalogArtifacts: (name: string, dryRun: boolean) =>
      post<CatalogCleanupResult>(
        `/catalog/apps/${enc(name)}/artifacts/cleanup${dryRun ? "?dryRun=true" : ""}`,
      ),
    /** presign → browser PUT to S3 → commit. Returns the committed artifact. */
    async uploadCatalogArtifact(
      name: string,
      file: File,
      platform: CatalogPlatform,
      tags: Record<string, string>,
    ): Promise<CatalogArtifact> {
      const grant = await post<CatalogUploadGrant>(
        `/catalog/apps/${enc(name)}/artifacts`,
        { platform, filename: file.name, size: file.size, tags },
      );
      const res = await fetchImpl(grant.url, {
        method: grant.method,
        headers: grant.headers,
        body: file,
      });
      if (!res.ok)
        throw new ApiError(
          res.status,
          "upload_failed",
          `artifact upload failed (${res.status})`,
        );
      return post<CatalogArtifact>(
        `/catalog/uploads/${enc(grant.uploadId)}/commit`,
      );
    },
    assetBundles: () =>
      get<{ bundles: AssetBundle[] }>("/assets/bundles").then((r) => r.bundles),
    assetBundle: (name: string) =>
      get<AssetBundleDetail>(`/assets/bundles/${enc(name)}`),
    createAssetBundle: (body: { name: string; description?: string }) =>
      post<AssetBundle>("/assets/bundles", body),
    updateAssetBundle: (
      name: string,
      body: { name?: string; description?: string | null },
    ) => patch<AssetBundle>(`/assets/bundles/${enc(name)}`, body),
    deleteAssetBundle: (name: string) => del(`/assets/bundles/${enc(name)}`),
    assetVersion: (name: string, version: string) =>
      get<{ bundle: string; version: string; files: AssetFile[] }>(
        `/assets/bundles/${enc(name)}/versions/${enc(version)}`,
      ),
    deleteAssetVersion: (name: string, version: string) =>
      del(`/assets/bundles/${enc(name)}/versions/${enc(version)}`),
    /**
     * presign → browser PUT to S3 → commit, once per file. `path` is where the
     * file sits *inside* the bundle, which is what a map JSON's relative
     * references resolve against.
     */
    async uploadAssetFile(
      name: string,
      version: string,
      path: string,
      file: File,
    ): Promise<AssetFile> {
      const grant = await post<AssetUploadGrant>(
        `/assets/bundles/${enc(name)}/files`,
        { version, path, size: file.size },
      );
      const res = await fetchImpl(grant.url, {
        method: grant.method,
        // The signed `content-type` must go up verbatim; the browser would
        // otherwise send the File's own type and the PUT would 403.
        headers: grant.headers,
        body: file,
      });
      if (!res.ok)
        throw new ApiError(
          res.status,
          "upload_failed",
          `asset upload failed (${res.status})`,
        );
      return post<AssetFile>(`/assets/uploads/${enc(grant.uploadId)}/commit`);
    },
    installerDownloads: () =>
      get<{ downloads: InstallerDownload[] }>(
        "/catalog/installer/downloads",
      ).then((r) => r.downloads),
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
