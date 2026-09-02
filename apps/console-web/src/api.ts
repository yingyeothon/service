import type {
  ApiToken,
  AuditDetail,
  AuditFilter,
  AuditRow,
  ShotGrant,
  ShotUpload,
  ShowAcl,
  ShowDetail,
  ShowEntry,
  ShowEntryDetail,
  ShowGrant,
  ShowSubmittable,
  ShowSummary,
  ShowTargetKind,
  AssetBundle,
  AssetBundleDetail,
  Site,
  SiteDeploy,
  SiteDeployGrant,
  SiteDetail,
  AssetFile,
  AssetUploadGrant,
  CatalogApp,
  CatalogArtifact,
  CatalogCleanupResult,
  CatalogPlatform,
  CatalogSettings,
  CatalogUploadGrant,
  Channel,
  ChannelKind,
  ChannelDocKey,
  ChannelRedisUser,
  Comment,
  Discussion,
  DiscussionDetail,
  EventDetail,
  EventInput,
  EventPoster,
  EventRevision,
  EventSummary,
  HistoryPage,
  InstallerAppSetting,
  InstallerDownload,
  Issue,
  IssueDetail,
  IssueStatus,
  Me,
  Member,
  PosterUpload,
  Project,
  ProjectDetail,
  RemoveMemberResult,
  Team,
  TeamDetail,
  TeamMember,
  Version,
  VersionDetail,
  VersionLink,
  VersionLinkInput,
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
  const put = <T>(path: string, body?: unknown) =>
    call<T>("PUT", path, body ?? {});
  // Some deletes carry a moderation `reason`; `call` sends a body only when
  // one is given, so a plain delete is unchanged.
  const del = <T = void>(path: string, body?: unknown) =>
    call<T>("DELETE", path, body);
  const enc = encodeURIComponent;
  const qs = (params: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params))
      if (v !== undefined && v !== "") q.set(k, String(v));
    const s = q.toString();
    return s ? `?${s}` : "";
  };

  /** presign → browser PUT to S3. The signed headers go up verbatim. */
  async function putToGrant(
    grant: { url: string; method: string; headers: Record<string, string> },
    file: File,
    what: string,
  ): Promise<void> {
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
        `${what} upload failed (${res.status})`,
      );
  }

  const teamPath = (team: string) => `/teams/${enc(team)}`;
  const projectPath = (prj: string) => `/projects/${enc(prj)}`;
  const issuePath = (prj: string, n: number) =>
    `${projectPath(prj)}/issues/${enc(String(n))}`;
  const discussionPath = (team: string, id: string) =>
    `${teamPath(team)}/discussions/${enc(id)}`;

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

    // ---- teams -------------------------------------------------------------
    teams: (scope?: "mine" | "all") =>
      get<{ teams: Team[] }>(`/teams${qs({ scope })}`).then((r) => r.teams),
    createTeam: (body: { name: string; description?: string | null }) =>
      post<Team>("/teams", body),
    /** 202 with the name-only view; 404 hides unknown and not-allowed alike. */
    joinTeam: (name: string) => post<Team>("/teams/join", { name }),
    team: (team: string) => get<TeamDetail>(teamPath(team)),
    updateTeam: (
      team: string,
      body: { name?: string; description?: string | null },
    ) => patch<Team>(teamPath(team), body),
    deleteTeam: (team: string) => del(teamPath(team)),
    setTeamAdminLock: (team: string, locked: boolean) =>
      put<Team>(`${teamPath(team)}/admin-lock`, { locked }),
    teamMembers: (team: string) =>
      get<{ members: TeamMember[] }>(`${teamPath(team)}/members`).then(
        (r) => r.members,
      ),
    addTeamMember: (team: string, login: string, role: "owner" | "member") =>
      post<TeamMember>(`${teamPath(team)}/members`, { login, role }),
    /** Approves a pending request, promotes or demotes, or (admin) appoints an owner. */
    setTeamMemberRole: (team: string, mid: string, role: "owner" | "member") =>
      patch<TeamMember>(`${teamPath(team)}/members/${enc(mid)}`, { role }),
    /** Kick (owner) or leave (self). `undefined` when a pending request was declined/withdrawn. */
    removeTeamMember: (team: string, mid: string) =>
      del<RemoveMemberResult | undefined>(
        `${teamPath(team)}/members/${enc(mid)}`,
      ),
    teamHistory: (team: string, cursor?: string, limit?: number) =>
      get<HistoryPage>(
        `${teamPath(team)}/history${qs({ cursor, limit: limit ? String(limit) : undefined })}`,
      ),

    discussions: (team: string) =>
      get<{ discussions: Discussion[] }>(`${teamPath(team)}/discussions`).then(
        (r) => r.discussions,
      ),
    createDiscussion: (team: string, body: { title: string; bodyMd: string }) =>
      post<Discussion>(`${teamPath(team)}/discussions`, body),
    discussion: (team: string, id: string) =>
      get<DiscussionDetail>(discussionPath(team, id)),
    updateDiscussion: (
      team: string,
      id: string,
      body: { title?: string; bodyMd?: string },
    ) => patch<Discussion>(discussionPath(team, id), body),
    deleteDiscussion: (team: string, id: string) =>
      del(discussionPath(team, id)),
    addDiscussionComment: (team: string, id: string, bodyMd: string) =>
      post<Comment>(`${discussionPath(team, id)}/comments`, { bodyMd }),
    updateDiscussionComment: (
      team: string,
      id: string,
      cid: string,
      bodyMd: string,
    ) =>
      patch<Comment>(`${discussionPath(team, id)}/comments/${enc(cid)}`, {
        bodyMd,
      }),
    deleteDiscussionComment: (team: string, id: string, cid: string) =>
      del(`${discussionPath(team, id)}/comments/${enc(cid)}`),

    // ---- projects ----------------------------------------------------------
    projects: (team: string) =>
      get<{ projects: Project[] }>(`${teamPath(team)}/projects`).then(
        (r) => r.projects,
      ),
    createProject: (
      team: string,
      body: { name: string; description?: string | null },
    ) => post<Project>(`${teamPath(team)}/projects`, body),
    project: (prj: string) => get<ProjectDetail>(projectPath(prj)),
    updateProject: (
      prj: string,
      body: { name?: string; description?: string | null },
    ) => patch<Project>(projectPath(prj), body),
    deleteProject: (prj: string) => del(projectPath(prj)),

    versions: (prj: string) =>
      get<{ versions: Version[] }>(`${projectPath(prj)}/versions`).then(
        (r) => r.versions,
      ),
    createVersion: (
      prj: string,
      body: { name: string; note?: string | null },
    ) => post<Version>(`${projectPath(prj)}/versions`, body),
    bumpVersion: (prj: string, part: "patch" | "minor" | "major") =>
      post<Version>(`${projectPath(prj)}/versions/bump`, { part }),
    version: (prj: string, ver: string) =>
      get<VersionDetail>(`${projectPath(prj)}/versions/${enc(ver)}`),
    updateVersion: (prj: string, ver: string, note: string | null) =>
      patch<Version>(`${projectPath(prj)}/versions/${enc(ver)}`, { note }),
    deleteVersion: (prj: string, ver: string) =>
      del(`${projectPath(prj)}/versions/${enc(ver)}`),
    addVersionLink: (prj: string, ver: string, body: VersionLinkInput) =>
      post<VersionLink>(`${projectPath(prj)}/versions/${enc(ver)}/links`, body),
    removeVersionLink: (prj: string, ver: string, id: string) =>
      del(`${projectPath(prj)}/versions/${enc(ver)}/links/${enc(id)}`),

    teamIssues: (
      team: string,
      q: { status?: IssueStatus; limit?: number } = {},
    ) =>
      get<{ issues: Issue[] }>(
        `${teamPath(team)}/issues${qs({ status: q.status, limit: q.limit === undefined ? undefined : String(q.limit) })}`,
      ).then((r) => r.issues),
    issues: (prj: string, status?: IssueStatus) =>
      get<{ issues: Issue[] }>(
        `${projectPath(prj)}/issues${qs({ status })}`,
      ).then((r) => r.issues),
    createIssue: (
      prj: string,
      body: { title: string; bodyMd?: string; versionId?: string | null },
    ) => post<Issue>(`${projectPath(prj)}/issues`, body),
    issue: (prj: string, n: number) => get<IssueDetail>(issuePath(prj, n)),
    updateIssue: (
      prj: string,
      n: number,
      body: { title?: string; bodyMd?: string; versionId?: string | null },
    ) => patch<Issue>(issuePath(prj, n), body),
    setIssueStatus: (prj: string, n: number, to: "close" | "reopen") =>
      post<Issue>(`${issuePath(prj, n)}/${to}`),
    addIssueComment: (prj: string, n: number, bodyMd: string) =>
      post<Comment>(`${issuePath(prj, n)}/comments`, { bodyMd }),
    updateIssueComment: (prj: string, n: number, cid: string, bodyMd: string) =>
      patch<Comment>(`${issuePath(prj, n)}/comments/${enc(cid)}`, { bodyMd }),
    deleteIssueComment: (prj: string, n: number, cid: string) =>
      del(`${issuePath(prj, n)}/comments/${enc(cid)}`),

    // ---- admin settings ----------------------------------------------------
    installerApp: () =>
      get<InstallerAppSetting>("/admin/settings/installer-app"),
    setInstallerApp: (appId: string | null) =>
      put<InstallerAppSetting>("/admin/settings/installer-app", { appId }),

    // ---- channels ----------------------------------------------------------
    /** Every channel of every team the caller sits in; `scope: "all"` is admin only. */
    channels: (opts: { kind?: ChannelKind; scope?: "mine" | "all" } = {}) =>
      get<{ channels: Channel[] }>(
        `/channels${qs({ kind: opts.kind, scope: opts.scope })}`,
      ).then((r) => r.channels),
    projectChannels: (prj: string, kind?: ChannelKind) =>
      get<{ channels: Channel[] }>(
        `${projectPath(prj)}/channels${qs({ kind })}`,
      ).then((r) => r.channels),
    channel: (id: string) => get<Channel>(`/channels/${enc(id)}`),
    createChannel: (
      prj: string,
      body: { kind: ChannelKind; name: string; config: unknown },
    ) => post<Channel>(`${projectPath(prj)}/channels`, body),
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

    // ---- events ------------------------------------------------------------
    events: () =>
      get<{ events: EventSummary[] }>("/events").then((r) => r.events),
    event: (id: string) => get<EventDetail>(`/events/${enc(id)}`),
    createEvent: (body: EventInput) => post<EventDetail>("/events", body),
    updateEvent: (id: string, body: Partial<EventInput>) =>
      patch<EventDetail>(`/events/${enc(id)}`, body),
    publishEvent: (id: string) =>
      post<EventDetail>(`/events/${enc(id)}/publish`),
    cancelEvent: (id: string) => post<EventDetail>(`/events/${enc(id)}/cancel`),
    deleteEvent: (id: string) => del(`/events/${enc(id)}`),
    vote: (id: string, optionIds: string[]) =>
      put<{ eventId: string; optionIds: string[] }>(`/events/${enc(id)}/vote`, {
        optionIds,
      }),
    unvote: (id: string) => del(`/events/${enc(id)}/vote`),
    /** Platform admin: ends the vote now. `optionId` overrides the tally. */
    closeEventVote: (id: string, reason: string, optionId?: string) =>
      post<EventDetail>(`/events/${enc(id)}/close-vote`, {
        reason,
        ...(optionId !== undefined ? { optionId } : {}),
      }),
    eventRevisions: (id: string) =>
      get<{ revisions: EventRevision[] }>(`/events/${enc(id)}/revisions`).then(
        (r) => r.revisions,
      ),
    eventRevision: (id: string, n: number) =>
      get<Required<EventRevision>>(`/events/${enc(id)}/revisions/${n}`),
    eventPosters: (id: string) =>
      get<{ posters: EventPoster[] }>(`/events/${enc(id)}/posters`).then(
        (r) => r.posters,
      ),
    addEventComment: (id: string, bodyMd: string) =>
      post<Comment>(`/events/${enc(id)}/comments`, { bodyMd }),
    updateEventComment: (id: string, cid: string, bodyMd: string) =>
      patch<Comment>(`/events/${enc(id)}/comments/${enc(cid)}`, { bodyMd }),
    deleteEventComment: (id: string, cid: string) =>
      del(`/events/${enc(id)}/comments/${enc(cid)}`),

    /** presign → browser PUT to S3 → commit. Returns the refreshed event. */
    async uploadPoster(id: string, file: File): Promise<EventDetail> {
      const grant = await post<PosterUpload>(`/events/${enc(id)}/poster`, {
        contentType: file.type,
        size: file.size,
      });
      await putToGrant(grant, file, "poster");
      return post<EventDetail>(`/events/${enc(id)}/poster/commit`, {
        key: grant.key,
      });
    },
    deletePoster: (id: string) => del(`/events/${enc(id)}/poster`),

    // ---- shows (the gallery; platform-global, so no team in the path) ------
    shows: (q: { state?: "open" | "closed"; cursor?: string } = {}) =>
      get<{ shows: ShowSummary[]; next: string | null }>(
        `/shows${qs({ state: q.state, cursor: q.cursor })}`,
      ),
    show: (id: string) => get<ShowDetail>(`/shows/${enc(id)}`),
    createShow: (body: { title: string; bodyMd?: string; acl?: ShowAcl }) =>
      post<{ id: string }>("/shows", body),
    updateShow: (
      id: string,
      body: { title?: string; bodyMd?: string; acl?: ShowAcl; reason?: string },
    ) => patch<void>(`/shows/${enc(id)}`, body),
    closeShow: (id: string, reason?: string) =>
      post<void>(`/shows/${enc(id)}/close`, reason ? { reason } : {}),
    reopenShow: (id: string, reason?: string) =>
      post<void>(`/shows/${enc(id)}/reopen`, reason ? { reason } : {}),
    deleteShow: (id: string, reason: string) =>
      del(`/shows/${enc(id)}`, { reason }),
    openShowForEvent: (eventId: string) =>
      post<{ id: string }>(`/events/${enc(eventId)}/show`, {}),

    showGrants: (id: string) =>
      get<{ grants: ShowGrant[] }>(`/shows/${enc(id)}/grants`).then(
        (r) => r.grants,
      ),
    grantShow: (id: string, login: string, reason?: string) =>
      put<void>(
        `/shows/${enc(id)}/grants/${enc(login)}`,
        reason ? { reason } : {},
      ),
    revokeShow: (id: string, login: string, reason?: string) =>
      del(`/shows/${enc(id)}/grants/${enc(login)}`, reason ? { reason } : {}),
    showSubmittable: (id: string) =>
      get<{ targets: ShowSubmittable[] }>(`/shows/${enc(id)}/submittable`).then(
        (r) => r.targets,
      ),

    showEntries: (
      id: string,
      q: { sort?: "new" | "likes"; cursor?: string } = {},
    ) =>
      get<{ entries: ShowEntry[]; next: string | null }>(
        `/shows/${enc(id)}/entries${qs({ sort: q.sort, cursor: q.cursor })}`,
      ),
    showEntry: (id: string, entry: string) =>
      get<ShowEntryDetail>(`/shows/${enc(id)}/entries/${enc(entry)}`),
    submitEntry: (
      id: string,
      body: {
        targetKind: ShowTargetKind;
        targetId: string;
        title: string;
        bodyMd?: string;
        reason?: string;
      },
    ) => post<{ id: string }>(`/shows/${enc(id)}/entries`, body),
    updateEntry: (
      id: string,
      entry: string,
      body: {
        title?: string;
        bodyMd?: string;
        targetRef?: string;
        reason?: string;
      },
    ) => patch<void>(`/shows/${enc(id)}/entries/${enc(entry)}`, body),
    deleteEntry: (id: string, entry: string, reason?: string) =>
      del(`/shows/${enc(id)}/entries/${enc(entry)}`, reason ? { reason } : {}),

    likeEntry: (id: string, entry: string) =>
      put<void>(`/shows/${enc(id)}/entries/${enc(entry)}/like`),
    unlikeEntry: (id: string, entry: string) =>
      del(`/shows/${enc(id)}/entries/${enc(entry)}/like`),
    addEntryComment: (id: string, entry: string, bodyMd: string) =>
      post<{ id: string }>(`/shows/${enc(id)}/entries/${enc(entry)}/comments`, {
        bodyMd,
      }),
    editEntryComment: (
      id: string,
      entry: string,
      cid: string,
      bodyMd: string,
      reason?: string,
    ) =>
      patch<void>(
        `/shows/${enc(id)}/entries/${enc(entry)}/comments/${enc(cid)}`,
        reason ? { bodyMd, reason } : { bodyMd },
      ),
    deleteEntryComment: (
      id: string,
      entry: string,
      cid: string,
      reason?: string,
    ) =>
      del(
        `/shows/${enc(id)}/entries/${enc(entry)}/comments/${enc(cid)}`,
        reason ? { reason } : {},
      ),

    /**
     * One presign for the whole batch, then the PUTs, then one commit that
     * sets the entire list — so a failed upload leaves the entry with exactly
     * the screenshots it already had. `keepIds` are the shots already live
     * that the caller kept; screenshots are addressed by **id**, never by
     * object key (the key is server-minted and never leaves the server).
     */
    async setEntryScreenshots(
      id: string,
      entry: string,
      files: File[],
      keepIds: string[],
    ): Promise<void> {
      const path = `/shows/${enc(id)}/entries/${enc(entry)}/shots`;
      let added: ShotGrant[] = [];
      if (files.length > 0) {
        // One call, not one per file: each presign takes the caller's 500 ms
        // write slot, so three of them in a row would 429.
        const grant = await post<ShotUpload>(path, {
          files: files.map((f) => ({ contentType: f.type, size: f.size })),
        });
        added = grant.grants;
        const results = await Promise.allSettled(
          added.map((g, i) => putToGrant(g, files[i]!, "screenshot")),
        );
        const failed = results.find((r) => r.status === "rejected");
        // Throw *before* the commit: the entry keeps what it had rather than
        // ending up with a half-replaced set.
        if (failed) throw failed.reason;
      }
      await put<void>(path, { ids: [...keepIds, ...added.map((g) => g.id)] });
    },

    // ---- audit log (admin only) --------------------------------------------
    audit: (f: AuditFilter = {}) =>
      get<{ rows: AuditRow[]; next: string | null }>(
        `/admin/audit${qs({ ...f })}`,
      ),
    auditRow: (id: string) => get<AuditDetail>(`/admin/audit/${enc(id)}`),

    // ---- binary catalog (apps are addressed by id) -------------------------
    projectCatalogApps: (prj: string) =>
      get<{ apps: CatalogApp[] }>(`${projectPath(prj)}/catalog/apps`).then(
        (r) => r.apps,
      ),
    createCatalogApp: (
      prj: string,
      body: { name: string; path: string; description?: string },
    ) => post<CatalogApp>(`${projectPath(prj)}/catalog/apps`, body),
    catalogApp: (id: string) => get<CatalogApp>(`/catalog/apps/${enc(id)}`),
    updateCatalogApp: (
      id: string,
      body: { name?: string; path?: string; description?: string | null },
    ) => patch<CatalogApp>(`/catalog/apps/${enc(id)}`, body),
    deleteCatalogApp: (id: string) => del(`/catalog/apps/${enc(id)}`),
    catalogSettings: (id: string) =>
      get<CatalogSettings>(`/catalog/apps/${enc(id)}/settings`),
    updateCatalogSettings: (id: string, body: Partial<CatalogSettings>) =>
      patch<CatalogSettings>(`/catalog/apps/${enc(id)}/settings`, body),
    catalogArtifacts: (id: string) =>
      get<{ artifacts: CatalogArtifact[] }>(
        `/catalog/apps/${enc(id)}/artifacts`,
      ).then((r) => r.artifacts),
    deleteCatalogArtifact: (id: string, artifactId: string) =>
      del(`/catalog/apps/${enc(id)}/artifacts/${enc(artifactId)}`),
    cleanupCatalogArtifacts: (id: string, dryRun: boolean) =>
      post<CatalogCleanupResult>(
        `/catalog/apps/${enc(id)}/artifacts/cleanup${dryRun ? "?dryRun=true" : ""}`,
      ),
    /** presign → browser PUT to S3 → commit. Returns the committed artifact. */
    async uploadCatalogArtifact(
      id: string,
      file: File,
      platform: CatalogPlatform,
      tags: Record<string, string>,
    ): Promise<CatalogArtifact> {
      const grant = await post<CatalogUploadGrant>(
        `/catalog/apps/${enc(id)}/artifacts`,
        { platform, filename: file.name, size: file.size, tags },
      );
      await putToGrant(grant, file, "artifact");
      return post<CatalogArtifact>(
        `/catalog/uploads/${enc(grant.uploadId)}/commit`,
      );
    },
    installerDownloads: () =>
      get<{ downloads: InstallerDownload[] }>(
        "/catalog/installer/downloads",
      ).then((r) => r.downloads),

    // ---- assets (bundles are addressed by id) ------------------------------
    projectAssetBundles: (prj: string) =>
      get<{ bundles: AssetBundle[] }>(
        `${projectPath(prj)}/assets/bundles`,
      ).then((r) => r.bundles),
    createAssetBundle: (
      prj: string,
      body: { name: string; description?: string },
    ) => post<AssetBundle>(`${projectPath(prj)}/assets/bundles`, body),
    assetBundle: (id: string) =>
      get<AssetBundleDetail>(`/assets/bundles/${enc(id)}`),
    updateAssetBundle: (
      id: string,
      body: { name?: string; description?: string | null },
    ) => patch<AssetBundle>(`/assets/bundles/${enc(id)}`, body),
    deleteAssetBundle: (id: string) => del(`/assets/bundles/${enc(id)}`),
    assetVersion: (id: string, version: string) =>
      get<{ bundle: string; version: string; files: AssetFile[] }>(
        `/assets/bundles/${enc(id)}/versions/${enc(version)}`,
      ),
    deleteAssetVersion: (id: string, version: string) =>
      del(`/assets/bundles/${enc(id)}/versions/${enc(version)}`),
    /**
     * presign → browser PUT to S3 → commit, once per file. `path` is where the
     * file sits *inside* the bundle, which is what a map JSON's relative
     * references resolve against.
     */
    async uploadAssetFile(
      id: string,
      version: string,
      path: string,
      file: File,
    ): Promise<AssetFile> {
      const grant = await post<AssetUploadGrant>(
        `/assets/bundles/${enc(id)}/files`,
        { version, path, size: file.size },
      );
      await putToGrant(grant, file, "asset");
      return post<AssetFile>(`/assets/uploads/${enc(grant.uploadId)}/commit`);
    },
    // ---- static sites (addressed by id) -------------------------------------
    projectSites: (prj: string) =>
      get<{ sites: Site[] }>(`${projectPath(prj)}/sites`).then((r) => r.sites),
    createSite: (prj: string, body: { name: string; description?: string }) =>
      post<Site & { warning: string }>(`${projectPath(prj)}/sites`, body),
    site: (id: string) => get<SiteDetail>(`/sites/${enc(id)}`),
    updateSite: (
      id: string,
      body: { name?: string; description?: string | null },
    ) => patch<Site>(`/sites/${enc(id)}`, body),
    deleteSite: (id: string) => del(`/sites/${enc(id)}`),
    siteDeploys: (id: string) =>
      get<{ deploys: SiteDeploy[] }>(`/sites/${enc(id)}/deploys`).then(
        (r) => r.deploys,
      ),
    siteDeploy: (id: string, deployId: string) =>
      get<SiteDeploy>(`/sites/${enc(id)}/deploys/${enc(deployId)}`),
    /**
     * presign → browser PUT of the zip → commit (202). The console extracts
     * asynchronously; poll `siteDeploy` until `live` or `failed`.
     */
    async deploySite(id: string, zip: File): Promise<SiteDeploy> {
      const grant = await post<SiteDeployGrant>(`/sites/${enc(id)}/deploys`, {
        size: zip.size,
      });
      await putToGrant(grant, zip, "site zip");
      return post<SiteDeploy>(
        `/sites/${enc(id)}/deploys/${enc(grant.deployId)}/commit`,
      );
    },
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
