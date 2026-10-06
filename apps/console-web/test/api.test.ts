import { describe, expect, it, vi } from "vitest";
import { ApiError, ASSET_DELETE_ROUNDS, createApiClient } from "../src/api";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("api client", () => {
  it("returns null from me() on 401 and throws ApiError otherwise", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonRes(401, { error: { code: "unauthorized", message: "no" } }),
      )
      .mockResolvedValueOnce(
        jsonRes(503, {
          error: { code: "unavailable", message: "db down", details: [1] },
        }),
      );
    const api = createApiClient({ baseUrl: "https://x.test/", fetch });
    expect(await api.me()).toBeNull();
    await expect(api.me()).rejects.toMatchObject({
      status: 503,
      code: "unavailable",
      message: "db down",
      details: [1],
    });
    expect(fetch.mock.calls[0]![0]).toBe("https://x.test/me");
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      credentials: "same-origin",
    });
  });

  it("falls back to the status line when the error body is not JSON", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response("<html>", { status: 502, statusText: "Bad Gateway" }),
      );
    const api = createApiClient({ fetch });
    const err = await api.tokens().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("http_error");
    expect((err as ApiError).message).toBe("502 Bad Gateway");
  });

  it("sends JSON bodies and treats 204 as void", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApiClient({ fetch });
    await expect(api.revokeToken("tok/1")).resolves.toBeUndefined();
    expect(fetch.mock.calls[0]![0]).toBe("/tokens/tok%2F1");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "DELETE" });
  });

  it("downloads google-services.json as a blob, named by the response", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response('{"project_info":{}}', {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition":
              'attachment; filename="google-services.json"',
          },
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(
        jsonRes(409, {
          error: {
            code: "conflict",
            message: "the channel has no platform registration",
            details: { reason: "not_registered" },
          },
        }),
      );
    const api = createApiClient({ fetch });
    const file = await api.channelGoogleServices("push/1");
    expect(file.filename).toBe("google-services.json");
    // jsdom's Blob has no `text()`; the size says the body arrived whole.
    expect(file.blob.size).toBe('{"project_info":{}}'.length);
    expect(fetch.mock.calls[0]![0]).toBe(
      "/channels/push%2F1/google-services.json",
    );
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
    });
    // No header: the route's own name.
    expect((await api.channelGoogleServices("push_1")).filename).toBe(
      "google-services.json",
    );
    await expect(api.channelGoogleServices("push_1")).rejects.toMatchObject({
      status: 409,
      details: { reason: "not_registered" },
    });
  });

  it("addresses the sender key and the push pool routes", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => Promise.resolve(jsonRes(200, {})));
    const api = createApiClient({ fetch });
    await api.setChannelSenderKey("push_1", "{}");
    await api.removeChannelSenderKey("push_1");
    await api.pushPool();
    await api.setPushSlotClosed("p1", true);
    await api.setPushSlotClosed("p1", false);
    expect(
      fetch.mock.calls.map(([url, init]) => `${init?.method} ${url as string}`),
    ).toEqual([
      "PUT /channels/push_1/sender-key",
      "DELETE /channels/push_1/sender-key",
      "GET /admin/push/pool",
      "POST /admin/push/pool/p1/close",
      "POST /admin/push/pool/p1/open",
    ]);
    expect(fetch.mock.calls[0]![1]?.body).toBe('{"serviceAccount":"{}"}');
    expect(fetch.mock.calls[1]![1]?.body).toBeUndefined();
  });

  it("uploads a poster via presign → PUT → commit", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonRes(200, {
          key: "posters/ev_1/x.png",
          url: "https://s3.test/put",
          method: "PUT",
          headers: { "content-type": "image/png", "content-length": "3" },
          expiresInSec: 600,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonRes(200, { id: "ev_1", posterUrl: "p" }));
    const api = createApiClient({ fetch });
    const file = new File([new Uint8Array(3)], "a.png", { type: "image/png" });
    const ev = await api.uploadPoster("ev_1", file);
    expect(ev.posterUrl).toBe("p");
    expect(fetch.mock.calls[0]![1]!.body).toBe(
      JSON.stringify({ contentType: "image/png", size: 3 }),
    );
    expect(fetch.mock.calls[1]![0]).toBe("https://s3.test/put");
    expect(fetch.mock.calls[1]![1]).toMatchObject({
      method: "PUT",
      headers: { "content-type": "image/png" },
    });
    expect(fetch.mock.calls[2]![1]!.body).toBe(
      JSON.stringify({ key: "posters/ev_1/x.png" }),
    );
  });

  it("reports a failed S3 PUT without committing", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonRes(200, {
          key: "k",
          url: "u",
          method: "PUT",
          headers: {},
          expiresInSec: 1,
        }),
      )
      .mockResolvedValueOnce(new Response("denied", { status: 403 }));
    const api = createApiClient({ fetch });
    await expect(
      api.uploadPoster("ev_1", new File(["x"], "a.png", { type: "image/png" })),
    ).rejects.toMatchObject({ code: "upload_failed", status: 403 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("session expiry", () => {
  it("reports a 401 outside me() to the unauthorized handler", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        jsonRes(401, { error: { code: "unauthorized", message: "no" } }),
      );
    const onUnauthorized = vi.fn();
    const api = createApiClient({ fetch, onUnauthorized });
    await expect(api.tokens()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(await api.me()).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    api.setUnauthorizedHandler(undefined);
    await expect(api.tokens()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

describe("team and project routes", () => {
  it("addresses teams, projects, versions, issues and resources by id", async () => {
    const calls: Array<[string, string, string | undefined]> = [];
    const fetch = vi.fn<typeof globalThis.fetch>((url, init) => {
      calls.push([
        init?.method ?? "GET",
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
        typeof init?.body === "string" ? init.body : undefined,
      ]);
      return Promise.resolve(jsonRes(200, {}));
    });
    const api = createApiClient({ fetch });
    await api.teams("all");
    await api.joinTeam("studio");
    await api.setTeamMemberRole("team_1", "m/2", "owner");
    await api.teamHistory("team_1", "c u", 50);
    await api.createProject("team_1", { name: "game" });
    await api.bumpVersion("prj_1", "minor");
    await api.addVersionLink("prj_1", "ver_1", {
      kind: "asset_version",
      bundleId: "ab_1",
      assetVersion: "v1",
    });
    await api.issues("prj_1", "closed");
    await api.setIssueStatus("prj_1", 7, "close");
    await api.createChannel("prj_1", { kind: "q", name: "x", config: {} });
    await api.projectChannels("prj_1", "auth");
    await api.createCatalogApp("prj_1", { name: "a", path: "life.yyt.a" });
    await api.catalogSettings("ca_1");
    await api.createAssetBundle("prj_1", { name: "b" });
    await api.assetBundle("ab_1");
    await api.createSite("prj_1", { name: "s" });
    await api.site("st_1");
    await api.siteDeploy("st_1", "sd_1");
    await api.setInstallerApp(null);
    await api.projectKv("prj_1", { sort: "entries", order: "desc" });
    await api.createKv("prj_1", {
      name: "profiles",
      readScope: "project",
      writeScope: "user",
    });
    await api.kv("kv_1");
    await api.kvEntries("kv_1", { prefix: "p/", owner: "a b", cursor: "c=" });
    await api.kvEntry("kv_1", "k:1", "o1");
    await api.putKvEntry("kv_1", "k/1", {
      owner: "o1",
      valueText: '{"hp":1}',
      ttl: 60,
      ifVersion: 2,
    });
    await api.deleteKvEntry("kv_1", "k:1");
    await api.deleteKvOwner("kv_1", "o1");
    await api.kitConfig("prj_1");
    await api.kitConfig("prj_1", { auth: "auth one" });
    expect(calls).toEqual([
      ["GET", "/teams?scope=all", undefined],
      ["POST", "/teams/join", '{"name":"studio"}'],
      ["PATCH", "/teams/team_1/members/m%2F2", '{"role":"owner"}'],
      ["GET", "/teams/team_1/history?cursor=c+u&limit=50", undefined],
      ["POST", "/teams/team_1/projects", '{"name":"game"}'],
      ["POST", "/projects/prj_1/versions/bump", '{"part":"minor"}'],
      [
        "POST",
        "/projects/prj_1/versions/ver_1/links",
        '{"kind":"asset_version","bundleId":"ab_1","assetVersion":"v1"}',
      ],
      ["GET", "/projects/prj_1/issues?status=closed", undefined],
      ["POST", "/projects/prj_1/issues/7/close", "{}"],
      [
        "POST",
        "/projects/prj_1/channels",
        '{"kind":"q","name":"x","config":{}}',
      ],
      ["GET", "/projects/prj_1/channels?kind=auth", undefined],
      [
        "POST",
        "/projects/prj_1/catalog/apps",
        '{"name":"a","path":"life.yyt.a"}',
      ],
      ["GET", "/catalog/apps/ca_1/settings", undefined],
      ["POST", "/projects/prj_1/assets/bundles", '{"name":"b"}'],
      ["GET", "/assets/bundles/ab_1", undefined],
      ["POST", "/projects/prj_1/sites", '{"name":"s"}'],
      ["GET", "/sites/st_1", undefined],
      ["GET", "/sites/st_1/deploys/sd_1", undefined],
      ["PUT", "/admin/settings/installer-app", '{"appId":null}'],
      ["GET", "/projects/prj_1/kv?sort=entries&order=desc", undefined],
      [
        "POST",
        "/projects/prj_1/kv",
        '{"name":"profiles","readScope":"project","writeScope":"user"}',
      ],
      ["GET", "/kv/kv_1", undefined],
      ["GET", "/kv/kv_1/entries?prefix=p%2F&owner=a+b&cursor=c%3D", undefined],
      ["GET", "/kv/kv_1/entries/k%3A1?owner=o1", undefined],
      [
        "PUT",
        "/kv/kv_1/entries/k%2F1",
        '{"owner":"o1","valueText":"{\\"hp\\":1}","ttl":60,"ifVersion":2}',
      ],
      ["DELETE", "/kv/kv_1/entries/k%3A1", undefined],
      ["DELETE", "/kv/kv_1/entries?owner=o1", undefined],
      ["GET", "/projects/prj_1/kit-config", undefined],
      ["GET", "/projects/prj_1/kit-config?auth=auth+one", undefined],
    ]);
  });

  it("uploads screenshots in one presign and commits ids, never object keys", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calls.push({ url, init });
      if (url.endsWith("/shots") && init?.method === "POST")
        return jsonRes(200, {
          grants: [
            {
              id: "ss_new",
              url: "https://s3.test/put/one",
              method: "PUT",
              headers: { "content-type": "image/png" },
            },
          ],
          expiresInSec: 600,
        });
      if (url.startsWith("https://s3.test/"))
        return new Response(null, { status: 200 });
      return new Response(null, { status: 204 });
    });
    const api = createApiClient({ baseUrl: "https://x.test", fetch });
    const file = new File([new Uint8Array([1])], "a.png", {
      type: "image/png",
    });
    await api.setEntryScreenshots("sh_1", "se_1", [file], ["ss_kept"]);

    // One presign for the whole batch: each one takes the caller's 500 ms
    // write slot, so a call per file would 429.
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
    // The commit carries **ids**, in keep-then-added order. Object keys are
    // server-minted and never leave the server.
    const commit = calls.find(
      (c) => c.init?.method === "PUT" && c.url.startsWith("https://x.test"),
    )!;
    expect(JSON.parse(commit.init!.body as string)).toEqual({
      ids: ["ss_kept", "ss_new"],
    });
    // The presigned PUT goes to S3 with exactly the signed headers.
    const upload = calls.find((c) => c.url.startsWith("https://s3.test"))!;
    expect(upload.init!.headers).toEqual({ "content-type": "image/png" });
  });

  it("keeps the entry untouched when an upload fails", async () => {
    const seen: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/shots") && init?.method === "POST")
        return jsonRes(200, {
          grants: [
            {
              id: "ss_new",
              url: "https://s3.test/put/one",
              method: "PUT",
              headers: {},
            },
          ],
          expiresInSec: 600,
        });
      if (url.startsWith("https://s3.test/"))
        return new Response("no", { status: 403 });
      return new Response(null, { status: 204 });
    });
    const api = createApiClient({ baseUrl: "https://x.test", fetch });
    const file = new File([new Uint8Array([1])], "a.png", {
      type: "image/png",
    });
    await expect(
      api.setEntryScreenshots("sh_1", "se_1", [file], []),
    ).rejects.toMatchObject({ code: "upload_failed" });
    // It threw *before* the commit, so the entry keeps what it had.
    expect(seen.some((s) => s.startsWith("PUT https://x.test"))).toBe(false);
  });

  it("serialises list params and drops the empty ones", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => Promise.resolve(jsonRes(200, { teams: [] })));
    const api = createApiClient({ baseUrl: "https://x.test/", fetch });
    await api.teams(undefined, { sort: "updatedAt", order: "desc", q: "dun" });
    expect(fetch.mock.calls[0]![0]).toBe(
      "https://x.test/teams?sort=updatedAt&order=desc&q=dun",
    );
    await api.teams("all", { q: "" });
    expect(fetch.mock.calls[1]![0]).toBe("https://x.test/teams?scope=all");
    await api.projects("team_1");
    expect(fetch.mock.calls[2]![0]).toBe(
      "https://x.test/teams/team_1/projects",
    );
  });
});

describe("limit and paged asset routes", () => {
  it("builds each limit route and the paged file lists", async () => {
    const calls: Array<[string, string, string | undefined]> = [];
    const fetch = vi.fn<typeof globalThis.fetch>((url, init) => {
      calls.push([
        init?.method ?? "GET",
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
        typeof init?.body === "string" ? init.body : undefined,
      ]);
      return Promise.resolve(
        init?.method === "DELETE"
          ? new Response(null, { status: 204 })
          : jsonRes(200, {}),
      );
    });
    const api = createApiClient({ fetch });
    await api.limits("bundle:ab_1");
    await api.requestLimit({
      scope: "channel:auth_1",
      key: "channel.lifetime",
      value: "unlimited",
      reason: "event",
    });
    await api.limitRequests("team_1", { status: "pending", cursor: "lr_9" });
    await api.cancelLimitRequest("lr_1");
    await api.adminLimitRequests({ status: "pending", limit: 1 });
    await api.approveLimitRequest("lr_1", { value: 1024 });
    await api.rejectLimitRequest("lr_1", "no");
    await api.setLimitOverride("bundle", "ab_1", "asset.fileBytes", {
      value: 4096,
      note: "contest",
    });
    await api.revokeLimitOverride("bundle", "ab_1", "asset.fileBytes", "done");
    await api.assetVersion("ab_1", "v 1", { cursor: "a/b.json", limit: 500 });
    await api.assetFiles("ab_1", "v1");
    expect(calls).toEqual([
      ["GET", "/limits?scope=bundle%3Aab_1", undefined],
      [
        "POST",
        "/limit-requests",
        '{"scope":"channel:auth_1","key":"channel.lifetime","value":"unlimited","reason":"event"}',
      ],
      [
        "GET",
        "/limit-requests?team=team_1&status=pending&cursor=lr_9",
        undefined,
      ],
      ["POST", "/limit-requests/lr_1/cancel", "{}"],
      ["GET", "/admin/limit-requests?status=pending&limit=1", undefined],
      ["POST", "/admin/limit-requests/lr_1/approve", '{"value":1024}'],
      ["POST", "/admin/limit-requests/lr_1/reject", '{"note":"no"}'],
      [
        "PUT",
        "/admin/limit-overrides/bundle/ab_1/asset.fileBytes",
        '{"value":4096,"note":"contest"}',
      ],
      [
        "DELETE",
        "/admin/limit-overrides/bundle/ab_1/asset.fileBytes",
        '{"note":"done"}',
      ],
      [
        "GET",
        "/assets/bundles/ab_1/versions/v%201?cursor=a%2Fb.json&limit=500",
        undefined,
      ],
      ["GET", "/assets/bundles/ab_1/files?version=v1", undefined],
    ]);
  });
});

describe("live asset bundles", () => {
  it("creates with a mode, pages live files and deletes paths", async () => {
    const calls: Array<[string, string, string | undefined]> = [];
    const fetch = vi.fn<typeof globalThis.fetch>((url, init) => {
      calls.push([
        init?.method ?? "GET",
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
        typeof init?.body === "string" ? init.body : undefined,
      ]);
      return Promise.resolve(
        jsonRes(200, {
          deleted: ["a.json"],
          missing: [],
          skipped: [],
          failed: [],
        }),
      );
    });
    const api = createApiClient({ fetch });
    await api.createAssetBundle("prj_1", { name: "content", mode: "live" });
    await api.assetLiveFiles("ab_1", { cursor: "a/b.json" });
    await api.assetLiveFiles("ab_1");
    expect(await api.deleteAssetFiles("ab_1", ["a.json"])).toMatchObject({
      deleted: ["a.json"],
    });
    expect(calls).toEqual([
      [
        "POST",
        "/projects/prj_1/assets/bundles",
        '{"name":"content","mode":"live"}',
      ],
      ["GET", "/assets/bundles/ab_1/files?cursor=a%2Fb.json", undefined],
      ["GET", "/assets/bundles/ab_1/files", undefined],
      ["DELETE", "/assets/bundles/ab_1/files", '{"paths":["a.json"]}'],
    ]);
  });

  it("repeats a bundle or version delete while it answers 202", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonRes(202, { done: false, deleted: 2000, failed: 0 }),
      )
      .mockResolvedValueOnce(
        jsonRes(202, { done: false, deleted: 1000, failed: 1 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApiClient({ fetch });
    const seen: number[] = [];
    await expect(
      api.deleteAssetBundle("ab_1", (n) => seen.push(n)),
    ).resolves.toBeUndefined();
    expect(seen).toEqual([2000, 3000]);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe("/assets/bundles/ab_1");
      expect(init).toMatchObject({ method: "DELETE" });
    }
    await api.deleteAssetVersion("ab_1", "v 1");
    expect(fetch.mock.calls[3]![0]).toBe("/assets/bundles/ab_1/versions/v%201");
  });

  it("gives up after a bounded number of 202s and says how far it got", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() =>
        Promise.resolve(jsonRes(202, { done: false, deleted: 10, failed: 0 })),
      );
    const api = createApiClient({ fetch });
    const err = await api.deleteAssetBundle("ab_1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toMatch(
      new RegExp(
        `after ${ASSET_DELETE_ROUNDS} rounds \\(${ASSET_DELETE_ROUNDS * 10} files`,
      ),
    );
    expect(fetch).toHaveBeenCalledTimes(ASSET_DELETE_ROUNDS);
  });

  it("surfaces an error that arrives mid-way", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonRes(202, { done: false, deleted: 5, failed: 0 }),
      )
      .mockResolvedValueOnce(
        jsonRes(503, {
          error: {
            code: "unavailable",
            message: "1 object(s) could not be deleted; retry",
          },
        }),
      );
    const api = createApiClient({ fetch });
    await expect(api.deleteAssetVersion("ab_1", "v1")).rejects.toMatchObject({
      status: 503,
      message: "1 object(s) could not be deleted; retry",
    });
  });
});

describe("asset uploads over the single-PUT ceiling", () => {
  it("refuses a multipart grant before any PUT and names the CLI", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      jsonRes(201, {
        uploadId: "u1",
        key: "assets/ab_1/v1/world.bin",
        multipart: true,
        partSize: 32 * 1024 * 1024,
        partCount: 4,
        size: 100 * 1024 * 1024,
        expiresAt: 1,
      }),
    );
    const api = createApiClient({ baseUrl: "https://x.test/", fetch });
    const file = new File(["x"], "world.bin");
    const err = await api
      .uploadAssetFile("ab_1", "v1", "world.bin", file)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("multipart_upload");
    expect((err as ApiError).message).toMatch(/yyt asset sync/);
    // The presign only: no PUT, no commit.
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
