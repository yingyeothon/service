import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "../src/api";

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
    await api.setInstallerApp(null);
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
      ["PUT", "/admin/settings/installer-app", '{"appId":null}'],
    ]);
  });
});
