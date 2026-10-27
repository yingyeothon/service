import { sha256Hex } from "@yyt/core";
import { describe, expect, it } from "vitest";
import { SHARE_PAGE_CSP } from "../src/share-page.js";
import {
  SHARE_LINK_ROWS_PER_APP,
  SHARE_LINKS_PER_APP,
} from "../src/share-links.js";
import { ev, harness, NOW_SEC, parse, type Team } from "./helpers.js";

/*
 * Catalog share links (docs/decisions.md *Catalog share links and install
 * bridge*, todo/80): a team mints expiring bearer links for any app, a public
 * listing has a permanent one, and every link that does not resolve renders
 * the same page.
 */

type H = ReturnType<typeof harness>;
type Link = {
  id: string;
  url: string;
  label: string | null;
  createdBy: string | null;
  expiresAt: number;
  revokedAt: number | null;
  live: boolean;
};

async function makeApp(h: H, u: Team, name = "myapp") {
  h.clock.tick(1);
  const r = await h.app(
    ev("POST", `/projects/${u.prjId}/catalog/apps`, {
      body: { name, path: `life.yyt.${name}` },
      headers: u.cookie,
    }),
  );
  expect(r.statusCode, r.body).toBe(201);
  return parse<{ id: string; name: string }>(r);
}

async function seedBuilds(h: H, appId: string) {
  await h.catalog.insertArtifact({
    id: `${appId}_aab`,
    appId,
    platform: "android",
    url: `https://dev-d.yyt.life/apps/${appId}/u0/app.aab`,
    tags: { version: "0.9.0+1" },
    createdAt: NOW_SEC - 10,
  });
  await h.catalog.insertArtifact({
    id: `${appId}_apk`,
    appId,
    platform: "android",
    url: `https://dev-d.yyt.life/apps/${appId}/u1/app-release.apk`,
    tags: { version: "1.2.3+4", application_id: "life.yyt.game" },
    createdAt: NOW_SEC,
  });
  await h.catalog.insertArtifact({
    id: `${appId}_ipa`,
    appId,
    platform: "ios",
    url: `https://dev-d.yyt.life/apps/${appId}/u2/Runner.ipa`,
    tags: {
      version: "1.2.3+4",
      bundle_id: "life.yyt.game",
      build_number: "4",
      distribution_method: "ad-hoc",
    },
    createdAt: NOW_SEC + 1,
  });
}

const create = (h: H, u: Team, appId: string, body: object = {}) => {
  h.clock.tick(1);
  return h.app(
    ev("POST", `/catalog/apps/${appId}/share-links`, {
      headers: u.cookie,
      body,
    }),
  );
};
const page = (h: H, ref: string, headers?: Record<string, string>) =>
  h.app(ev("GET", `/i/${ref}`, { headers }));
const twin = (h: H, ref: string) => h.app(ev("GET", `/catalog/share/${ref}`));
const tokenOf = (url: string) => url.split("/i/")[1]!;

describe("catalog share links", () => {
  it("mints a token link once, serves the page and the JSON twin, lists without the token, revokes", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9201);
    const app = await makeApp(h, owner);
    await seedBuilds(h, app.id);

    const r = await create(h, owner, app.id, { label: "QA crew" });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.headers?.["cache-control"]).toContain("no-store");
    const link = parse<Link>(r);
    expect(link.url).toMatch(/^https:\/\/[^/]+\/i\/shr_[0-9a-f]{32}$/);
    expect(link).toMatchObject({
      label: "QA crew",
      createdBy: "owner",
      expiresAt: Math.floor(h.clock.now() / 1000) + 7 * 86_400,
      revokedAt: null,
      live: true,
    });
    const token = tokenOf(link.url);
    // Only the hash is stored.
    const stored = [...h.listings.shareLinks.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(stored)).not.toContain(token);

    const p = await page(h, token);
    expect(p.statusCode).toBe(200);
    expect(p.headers?.["content-type"]).toBe("text/html; charset=utf-8");
    expect(p.headers?.["content-security-policy"]).toBe(SHARE_PAGE_CSP);
    expect(p.headers?.["referrer-policy"]).toBe("no-referrer");
    expect(p.headers?.["cache-control"]).toBe("no-store");
    const html = p.body as string;
    expect(html).toContain(
      '<meta property="og:title" content="myapp 1.2.3+4">',
    );
    // The newest Android build is the APK (the older AAB is never offered);
    // the iOS ad-hoc build gets its itms-services link.
    expect(html).toContain(
      `href="https://dev-d.yyt.life/apps/${app.id}/u1/app-release.apk"`,
    );
    expect(html).not.toContain("app.aab");
    expect(html).toContain("itms-services://?action=download-manifest");
    expect(html).toContain("<svg");
    expect(html).toContain('lang="ko"');
    // The label is the team's note, never the recipient's.
    expect(html).not.toContain("QA crew");
    expect(
      (await page(h, token, { "accept-language": "en-US,en;q=0.9" })).body,
    ).toContain('lang="en"');

    const t = await twin(h, token);
    expect(t.statusCode).toBe(200);
    const shared = parse<Record<string, unknown> & { artifacts: object[] }>(t);
    expect(shared).toMatchObject({
      kind: "token",
      appId: app.id,
      appName: "myapp",
      title: "myapp",
      summary: null,
      expiresAt: link.expiresAt,
    });
    expect(shared.artifacts).toHaveLength(2);
    expect(JSON.stringify(shared)).not.toContain("objectKey");

    const list = await h.app(
      ev("GET", `/catalog/apps/${app.id}/share-links`, {
        headers: owner.cookie,
      }),
    );
    expect(list.statusCode).toBe(200);
    const body = parse<{
      links: Link[];
      publicUrl: string | null;
      limit: number;
    }>(list);
    expect(body.publicUrl).toBeNull();
    expect(body.limit).toBe(SHARE_LINKS_PER_APP);
    expect(body.links.map((l) => l.id)).toEqual([link.id]);
    expect(list.body).not.toContain(token);

    h.clock.tick(1);
    const del = await h.app(
      ev("DELETE", `/catalog/apps/${app.id}/share-links/${link.id}`, {
        headers: owner.cookie,
      }),
    );
    expect(del.statusCode).toBe(204);
    h.clock.tick(1);
    // A second revoke is a no-op, an unknown id a 404.
    expect(
      (
        await h.app(
          ev("DELETE", `/catalog/apps/${app.id}/share-links/${link.id}`, {
            headers: owner.cookie,
          }),
        )
      ).statusCode,
    ).toBe(204);
    h.clock.tick(1);
    expect(
      (
        await h.app(
          ev("DELETE", `/catalog/apps/${app.id}/share-links/shl_nope`, {
            headers: owner.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
    expect((await page(h, token)).statusCode).toBe(404);
    expect((await twin(h, token)).statusCode).toBe(404);
    expect(
      h.db.audits
        .filter((a) => a.action.startsWith("catalog.share."))
        .map((a) => a.action),
    ).toEqual(["catalog.share.create", "catalog.share.revoke"]);
    const hist = JSON.stringify([...h.teamDb.history.values()]);
    expect(hist).toContain("share_link");
    expect(hist).not.toContain(token);
  });

  it("renders one unavailable page for every case it must not tell apart", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9211);
    const admin = await h.login("Boss", "admin", 9212);
    const app = await makeApp(h, owner);
    await seedBuilds(h, app.id);
    const expiring = parse<Link>(
      await create(h, owner, app.id, { expiresInDays: 1 }),
    );
    const taken = parse<Link>(await create(h, owner, app.id));

    const unavailable = async (ref: string) => {
      const p = await page(h, ref);
      expect(p.statusCode, ref).toBe(404);
      return p.body as string;
    };
    // No such app, an unlisted app, a malformed and an unknown token.
    const first = await unavailable("ca_missing");
    expect(await unavailable(app.id)).toBe(first);
    expect(await unavailable("shr_xyz")).toBe(first);
    expect(await unavailable(`shr_${"0".repeat(32)}`)).toBe(first);
    expect(await unavailable("x".repeat(200))).toBe(first);
    // A members listing is not public.
    h.clock.tick(1);
    await h.app(
      ev("PUT", `/catalog/apps/${app.id}/listing`, {
        headers: owner.cookie,
        body: { title: "Game", audience: "members" },
      }),
    );
    expect(await unavailable(app.id)).toBe(first);
    // Expired.
    h.clock.tick(86_400);
    expect(await unavailable(tokenOf(expiring.url))).toBe(first);
    // A takedown hides the app's token links too.
    expect((await page(h, tokenOf(taken.url))).statusCode).toBe(200);
    h.clock.tick(1);
    await h.app(
      ev("POST", `/admin/catalog/listings/${app.id}/takedown`, {
        headers: admin.cookie,
        body: {},
      }),
    );
    expect(await unavailable(tokenOf(taken.url))).toBe(first);
    expect((await twin(h, tokenOf(taken.url))).statusCode).toBe(404);
  });

  it("serves a public listing permanently by app id, with its summary", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9221);
    const app = await makeApp(h, owner);
    await seedBuilds(h, app.id);
    h.clock.tick(1);
    await h.app(
      ev("PUT", `/catalog/apps/${app.id}/listing`, {
        headers: owner.cookie,
        body: {
          title: 'My <b>"Game"</b>',
          summary: "First line\nsecond </script><script>alert(1)</script>",
          audience: "public",
        },
      }),
    );
    const p = await page(h, app.id);
    expect(p.statusCode).toBe(200);
    const html = p.body as string;
    expect(html).toContain("My &lt;b&gt;&quot;Game&quot;&lt;/b&gt; 1.2.3+4");
    expect(html).toContain('og:description" content="First line"');
    expect(html).not.toContain("<script>alert(1)");
    const t = parse<{ kind: string; summary: string; expiresAt: null }>(
      await twin(h, app.id),
    );
    expect(t).toMatchObject({ kind: "public", expiresAt: null });
    const list = parse<{ publicUrl: string }>(
      await h.app(
        ev("GET", `/catalog/apps/${app.id}/share-links`, {
          headers: owner.cookie,
        }),
      ),
    );
    expect(list.publicUrl).toMatch(new RegExp(`/i/${app.id}$`));
  });

  it("keeps outsiders out, validates the body and caps live links per app", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9231);
    const other = await h.team("other", "member", 9232);
    const app = await makeApp(h, owner);
    expect((await create(h, other, app.id)).statusCode).toBe(404);
    expect(
      (
        await h.app(
          ev("GET", `/catalog/apps/${app.id}/share-links`, {
            headers: other.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await h.app(
          ev("POST", `/catalog/apps/${app.id}/share-links`, { body: {} }),
        )
      ).statusCode,
    ).toBe(401);
    for (const bad of [
      { expiresInDays: 2 },
      { expiresInDays: 365 },
      { label: "a\nb" },
      { label: "x".repeat(101) },
      { extra: 1 },
    ])
      expect(
        (await create(h, owner, app.id, bad)).statusCode,
        JSON.stringify(bad),
      ).toBe(400);
    expect(
      parse<Link>(await create(h, owner, app.id, { expiresInDays: 30 }))
        .expiresAt,
    ).toBe(Math.floor(h.clock.now() / 1000) + 30 * 86_400);
    for (let i = 1; i < SHARE_LINKS_PER_APP; i++)
      expect(
        (await create(h, owner, app.id, { expiresInDays: 1 })).statusCode,
      ).toBe(201);
    const over = await create(h, owner, app.id);
    expect(over.statusCode).toBe(409);
    expect(parse<{ error: { details: unknown } }>(over).error.details).toEqual({
      limit: SHARE_LINKS_PER_APP,
      value: SHARE_LINKS_PER_APP,
    });
    // Expired links stop counting.
    h.clock.tick(86_400);
    expect((await create(h, owner, app.id)).statusCode).toBe(201);
  });

  it("bounds rows per app, dead ones included, and shows a members listing's text to nobody", async () => {
    const h = harness();
    const owner = await h.team("owner", "member", 9241);
    const app = await makeApp(h, owner);
    h.clock.tick(1);
    await h.app(
      ev("PUT", `/catalog/apps/${app.id}/listing`, {
        headers: owner.cookie,
        body: {
          title: "Members only",
          summary: "secret plan",
          audience: "members",
        },
      }),
    );
    let last = "";
    for (let i = 0; i < SHARE_LINK_ROWS_PER_APP; i++) {
      const l = parse<Link>(await create(h, owner, app.id));
      last = l.url;
      h.clock.tick(1);
      if (i < SHARE_LINK_ROWS_PER_APP - 1)
        await h.app(
          ev("DELETE", `/catalog/apps/${app.id}/share-links/${l.id}`, {
            headers: owner.cookie,
          }),
        );
    }
    const over = await create(h, owner, app.id);
    expect(over.statusCode).toBe(409);
    expect(parse<{ error: { details: unknown } }>(over).error.details).toEqual({
      limit: SHARE_LINK_ROWS_PER_APP,
      value: SHARE_LINK_ROWS_PER_APP,
    });
    const shared = parse<{ title: string; summary: string | null }>(
      await twin(h, tokenOf(last)),
    );
    expect(shared).toMatchObject({ title: "myapp", summary: null });
  });
});
