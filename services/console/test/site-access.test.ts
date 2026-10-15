import { describe, it, expect } from "vitest";
import { createMemorySiteEdgeDb } from "@yyt/console-db";
import { ev, harness, parse } from "./helpers.js";
import { siteAuthBody } from "../src/site-access.js";

const credentials = {
  mode: "basic",
  username: "viewer",
  password: "1234",
};
describe("approved site access", () => {
  it("requires approval, preserves protection across suspension, and never exposes credentials", async () => {
    const h = harness();
    const member = await h.team("alice");
    const admin = await h.login("boss", "admin");
    const call = (
      method: string,
      path: string,
      body: unknown,
      cookie = member.cookie,
    ) => {
      h.clock.tick(1);
      return h.app(ev(method, path, { body, headers: cookie }));
    };
    const created = await call("POST", `/projects/${member.prjId}/sites`, {
      name: "private",
    });
    expect(created.statusCode).toBe(201);
    const site = parse(created).id as string;
    const path = `/sites/${site}/auth`;
    expect((await call("PUT", path, credentials)).statusCode).toBe(403);
    const request = await call("POST", "/limit-requests", {
      scope: `site:${site}`,
      key: "site.basicAuth",
      value: 1,
      reason: "private preview",
    });
    expect(request.statusCode, request.body).toBe(201);
    expect((await call("PUT", path, credentials)).statusCode).toBe(403);
    expect(
      (
        await call(
          "PUT",
          `/admin/limit-overrides/site/${site}/site.basicAuth`,
          { value: 1, note: "shortcut" },
          admin.cookie,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(
          "POST",
          `/admin/limit-requests/${parse(request).id}/approve`,
          {},
          admin.cookie,
        )
      ).statusCode,
    ).toBe(200);
    const enabled = await call("PUT", path, credentials);
    expect(enabled.statusCode, enabled.body).toBe(202);
    expect(parse(enabled).access).toMatchObject({
      mode: "basic",
      suspended: false,
      username: "viewer",
      sync: "submitted",
    });
    expect(enabled.body).not.toContain(JSON.stringify(credentials.password));
    expect(enabled.body).not.toContain("digest");
    const secret = (await h.sites.findSite(site))!.accessJson;
    const stored = JSON.parse(secret!) as Record<string, unknown>;
    expect(stored).toMatchObject({
      mode: "basic",
      suspended: false,
      username: "viewer",
    });
    expect(Object.keys(stored).sort()).toEqual(
      ["mode", "suspended", "username", "salt", "digest"].sort(),
    );
    expect(stored.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(stored.digest).toMatch(/^[0-9a-f]{64}$/);
    const suspended = await call(
      "PUT",
      `/admin/sites/${site}/suspension`,
      { suspended: true, reason: "traffic" },
      admin.cookie,
    );
    expect(suspended.statusCode, suspended.body).toBe(202);
    expect((await call("PUT", path, { mode: "public" })).statusCode).toBe(403);
    expect(
      (await call("PATCH", `/sites/${site}`, { domain: "escape-route" }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call("POST", `/sites/${site}/deploys`, { size: 100 })).statusCode,
    ).toBe(403);
    const resumed = await call(
      "PUT",
      `/admin/sites/${site}/suspension`,
      { suspended: false, reason: "resolved" },
      admin.cookie,
    );
    expect(parse(resumed).access).toMatchObject({
      mode: "basic",
      suspended: false,
    });
    expect((await h.sites.findSite(site))!.accessJson).toBe(secret);
    expect(
      (
        await call(
          "DELETE",
          `/admin/limit-overrides/site/${site}/site.basicAuth`,
          { note: "revoke" },
          admin.cookie,
        )
      ).statusCode,
    ).toBe(400);
    expect((await call("PUT", path, { mode: "public" })).statusCode).toBe(202);
    expect(JSON.stringify(h.db.audits)).not.toContain(
      JSON.stringify(credentials.password),
    );
  });
  it("refuses an old public snapshot after authentication or suspension changes", async () => {
    const h = harness(),
      member = await h.team("alice");
    const site = parse(
      await h.app(
        ev("POST", `/projects/${member.prjId}/sites`, {
          headers: member.cookie,
          body: { name: "race" },
        }),
      ),
    ).id as string;
    const stale = (await h.sites.findSite(site))!;
    await h.siteAccess.configure(stale, {
      mode: "basic",
      username: "viewer",
      password: "0123456789abcdef0123456789abcdef",
    });
    await expect(h.siteAccess.publish(stale)).rejects.toThrow(
      "site access changed",
    );
    expect(
      (JSON.parse(h.siteEdge.rows.get(stale.slug)!.payload) as { mode: string })
        .mode,
    ).toBe("basic");
    const protectedRow = (await h.sites.findSite(site))!;
    await h.siteAccess.suspend(protectedRow, true);
    await expect(h.siteAccess.publish(protectedRow)).rejects.toThrow(
      "site access changed",
    );
    expect(
      (JSON.parse(h.siteEdge.rows.get(stale.slug)!.payload) as { mode: string })
        .mode,
    ).toBe("blocked");
  });
  it("rejects suspended writes at the claim boundary and preserves in-place names", async () => {
    const h = harness(),
      member = await h.team("alice");
    const site = parse(
      await h.app(
        ev("POST", `/projects/${member.prjId}/sites`, {
          headers: member.cookie,
          body: { name: "boundary" },
        }),
      ),
    ).id as string;
    const row = (await h.sites.findSite(site))!;
    h.clock.tick(1);
    expect(
      (
        await h.app(
          ev("PATCH", `/sites/${site}`, {
            headers: member.cookie,
            body: { domain: row.slug },
          }),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (JSON.parse(h.siteEdge.rows.get(row.slug)!.payload) as { mode: string })
        .mode,
    ).toBe("public");
    await h.siteAccess.suspend((await h.sites.findSite(site))!, true);
    await expect(h.sites.claimSite(site, "__deleting__", 1)).rejects.toThrow(
      "suspended",
    );
    await expect(
      h.sites.renameSite({
        siteId: site,
        teamId: row.teamId,
        target: "new-site",
        kind: "name",
        memberId: "member",
        at: 1,
        cap: 20,
        countSince: 0,
        moveId: "sd_race",
        hasFiles: false,
        expectSlug: row.slug,
        expectCurrentDeployId: null,
      }),
    ).rejects.toThrow("suspended");
  });
  it("denied requests never enable protection", async () => {
    const h = harness(),
      member = await h.team("alice"),
      admin = await h.login("boss", "admin");
    const site = parse(
      await h.app(
        ev("POST", `/projects/${member.prjId}/sites`, {
          headers: member.cookie,
          body: { name: "draft" },
        }),
      ),
    ).id as string;
    h.clock.tick(1);
    const request = parse(
      await h.app(
        ev("POST", "/limit-requests", {
          headers: member.cookie,
          body: {
            scope: `site:${site}`,
            key: "site.basicAuth",
            value: 1,
            reason: "preview",
          },
        }),
      ),
    );
    h.clock.tick(1);
    expect(
      (
        await h.app(
          ev("POST", `/admin/limit-requests/${request.id}/reject`, {
            headers: admin.cookie,
            body: { note: "not now" },
          }),
        )
      ).statusCode,
    ).toBe(200);
    h.clock.tick(1);
    expect(
      (
        await h.app(
          ev("PUT", `/sites/${site}/auth`, {
            headers: member.cookie,
            body: credentials,
          }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await h.siteAccess.view((await h.sites.findSite(site))!)).mode,
    ).toBe("public");
  });
});
describe("edge management budget", () => {
  it("counts failures, preserves emergency reserve and resets only at UTC month boundary", async () => {
    const db = createMemorySiteEdgeDb();
    const publish = async () => {};
    for (let i = 0; i < 45; i++) {
      await db.queue([{ prefix: "abc", payload: JSON.stringify({ n: i }) }]);
      await db.flush("2026-10", 90, publish);
    }
    await db.queue([{ prefix: "abc", payload: "changed" }]);
    await expect(db.flush("2026-10", 90, publish)).rejects.toThrow(
      "budget exhausted",
    );
    await expect(
      db.flush("2026-10", 100, async () => {
        throw new Error("lost response");
      }),
    ).rejects.toThrow("lost response");
    expect(db.used()).toBe(92);
    expect(await db.pending("abc")).toBe(true);
    await db.flush("2026-10", 100, publish);
    await db.queue([{ prefix: "abc", payload: "changed" }]);
    expect(await db.flush("2026-10", 90, publish)).toBe(0);
    await db.queue([{ prefix: "abc", payload: "next" }]);
    await db.flush("2026-11", 90, publish);
    expect(db.used()).toBe(2);
    await db.queue([{ prefix: "abc", payload: "late" }]);
    await expect(db.flush("2026-10", 90, publish)).rejects.toThrow(
      "stale management budget month",
    );
    expect(db.used()).toBe(2);
  });
});

describe("site password policy", () => {
  it("accepts four characters without composition rules and bounds Unicode length", () => {
    for (const value of [
      "1234",
      "aaaa",
      "    ",
      "가나다라",
      "🔑🌿🌙🍀",
      "🔑".repeat(128),
    ]) {
      expect(
        siteAuthBody.safeParse({
          mode: "basic",
          username: "viewer",
          password: value,
        }).success,
      ).toBe(true);
    }
    for (const value of [
      "",
      "abc",
      "🔑🔑🔑",
      "x".repeat(129),
      "🔑".repeat(129),
      "ab\ncd",
      "abc\ud800",
    ]) {
      expect(
        siteAuthBody.safeParse({
          mode: "basic",
          username: "viewer",
          password: value,
        }).success,
      ).toBe(false);
    }
  });
});
