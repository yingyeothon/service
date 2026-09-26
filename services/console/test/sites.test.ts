/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it } from "vitest";
import { nullLogger } from "@yyt/core";
import { createMemorySitesDb } from "@yyt/console-db";
import { createMemorySiteStore } from "../src/site-store.js";
import {
  errorText,
  healStaleDeploys,
  runSiteDeploy,
  runSiteNameSweep,
  runSiteSweep,
  SITE_DELETING,
  SITE_DEPLOYS_PER_HOUR,
  SITE_DEPLOYS_PER_MEMBER_HOUR,
  SITE_MAX_ZIP_BYTES,
  SITE_QUEUED_STALE_SEC,
  SITE_STAGING_GRACE_SEC,
  SITE_STALE_SEC,
  siteStagingKey,
} from "../src/site-deploy.js";
import { mintSlug, SITE_SHARED_ORIGIN_WARNING } from "../src/sites.js";
import {
  ev,
  harness,
  NOW_SEC,
  parse,
  SITE_CDN,
  SITE_HOST,
  type Team,
} from "./helpers.js";
import { makeZip, siteZip } from "./zipfix.js";

type H = ReturnType<typeof harness>;

async function mkSite(h: H, u: Team, name = "web", description?: string) {
  const r = await h.app(
    ev("POST", `/projects/${u.prjId}/sites`, {
      body: { name, ...(description ? { description } : {}) },
      headers: u.cookie,
    }),
  );
  expect(r.statusCode, r.body).toBe(201);
  return parse(r);
}

/** Grant → "PUT" (stage the zip) → commit. Returns the commit response. */
async function deploy(
  h: H,
  auth: { cookie: Record<string, string> },
  siteId: string,
  zip: Buffer,
  o: { contentType?: string; size?: number; skipPut?: boolean } = {},
) {
  const grant = await h.app(
    ev("POST", `/sites/${siteId}/deploys`, {
      body: { size: o.size ?? zip.length },
      headers: auth.cookie,
    }),
  );
  if (grant.statusCode !== 201) return grant;
  const { deployId } = parse(grant);
  if (!o.skipPut)
    h.siteStore.stageZip(siteStagingKey(deployId), zip, o.contentType);
  return h.app(
    ev("POST", `/sites/${siteId}/deploys/${deployId}/commit`, {
      headers: auth.cookie,
    }),
  );
}

const work = (h: H, deployId: string) =>
  runSiteDeploy(deployId, {
    sites: h.sites,
    store: h.siteStore,
    clock: h.clock,
    logger: nullLogger,
    concurrency: 2,
  });

describe("sites", () => {
  it("creates with a minted slug, lists per project and flattened, patches, refuses duplicates", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const s = await mkSite(h, alice, "game-web", "browser client");
    expect(s).toMatchObject({
      name: "game-web",
      description: "browser client",
      teamId: alice.teamId,
      teamName: "alice-team",
      projectId: alice.prjId,
      projectName: "game",
      createdBy: "alice",
      currentDeployId: null,
      busy: false,
      warning: SITE_SHARED_ORIGIN_WARNING,
    });
    expect(s.slug).toMatch(/^[a-z0-9]{9}$/);
    expect(s.publicUrl).toBe(`${SITE_CDN}/${s.slug}/`);
    expect(s.basePath).toBe(`/${s.slug}/`);

    expect(
      (
        await h.app(
          ev("POST", `/projects/${alice.prjId}/sites`, {
            body: { name: "Game-Web" },
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(409);
    for (const name of ["../x", "a/b", "", "st_deadbeef", "sd_1", "a.b"])
      expect(
        (
          await h.app(
            ev("POST", `/projects/${alice.prjId}/sites`, {
              body: { name },
              headers: alice.cookie,
            }),
          )
        ).statusCode,
        name,
      ).toBe(400);

    expect(
      parse(
        await h.app(ev("GET", "/sites", { headers: alice.cookie })),
      ).sites.map((x: { id: string }) => x.id),
    ).toEqual([s.id]);
    expect(
      parse(
        await h.app(
          ev("GET", `/projects/${alice.prjId}/sites`, {
            headers: alice.cookie,
          }),
        ),
      ).sites.map((x: { slug: string }) => x.slug),
    ).toEqual([s.slug]);

    const patched = await h.app(
      ev("PATCH", `/sites/${s.id}`, {
        body: { name: "renamed", description: null },
        headers: alice.cookie,
      }),
    );
    expect(parse(patched)).toMatchObject({
      name: "renamed",
      description: null,
      slug: s.slug,
    });
    // The project counts it and refuses deletion while it exists.
    expect(
      parse(
        await h.app(
          ev("GET", `/projects/${alice.prjId}`, { headers: alice.cookie }),
        ),
      ).counts.sites,
    ).toBe(1);
    expect(
      (
        await h.app(
          ev("DELETE", `/projects/${alice.prjId}`, { headers: alice.cookie }),
        )
      ).statusCode,
    ).toBe(409);
  });

  it("is team-gated like every resource: outsiders 404, seatless admin reads only", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const bob = await h.team("bob");
    const admin = await h.login("Boss", "admin");
    const s = await mkSite(h, alice);
    for (const [method, path, body] of [
      ["GET", `/sites/${s.id}`],
      ["PATCH", `/sites/${s.id}`, { description: "x" }],
      ["DELETE", `/sites/${s.id}`],
      ["GET", `/sites/${s.id}/deploys`],
      ["POST", `/sites/${s.id}/deploys`, { size: 10 }],
      ["GET", `/projects/${alice.prjId}/sites`],
    ] as const)
      expect(
        (
          await h.app(
            ev(method, path, {
              headers: bob.cookie,
              ...(body ? { body } : {}),
            }),
          )
        ).statusCode,
        `${method} ${path}`,
      ).toBe(404);
    expect(
      (await h.app(ev("GET", `/sites/${s.id}`, { headers: admin.cookie })))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await h.app(
          ev("POST", `/sites/${s.id}/deploys`, {
            body: { size: 10 },
            headers: admin.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app(
          ev("POST", `/projects/${alice.prjId}/sites`, {
            body: { name: "ops" },
            headers: admin.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    // Bob's own list does not see it either.
    expect(
      parse(await h.app(ev("GET", "/sites", { headers: bob.cookie }))).sites,
    ).toEqual([]);
  });

  it("deploys: grant → commit (202) → worker writes, prunes, invalidates → live", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const s = await mkSite(h, alice);
    const first = await deploy(h, alice, s.id, siteZip("one"));
    expect(first.statusCode, first.body).toBe(202);
    const d1 = parse(first);
    expect(d1).toMatchObject({ status: "queued", siteId: s.id });
    expect(h.invoked).toEqual([d1.id]);
    // While queued the site is busy and a second grant is refused to commit.
    expect(
      parse(await h.app(ev("GET", `/sites/${s.id}`, { headers: alice.cookie })))
        .busy,
    ).toBe(true);
    // Next second: the deploy list orders by (created_at, id) and two grants
    // in one second would tie on time.
    h.clock.tick(1);
    const second = await deploy(h, alice, s.id, siteZip("two"));
    expect(second.statusCode).toBe(409);
    // Committing the queued one again is idempotent.
    expect(
      (
        await h.app(
          ev("POST", `/sites/${s.id}/deploys/${d1.id}/commit`, {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(202);
    // Two commits of the same deploy racing (both saw `pending`) must leave
    // the claim in place: the loser must not release the winner's claim.
    await h.sites.transitionDeploy(
      d1.id,
      "queued",
      { status: "pending" },
      NOW_SEC,
    );
    h.clock.tick(1); // the claim is re-entrant only when the row changes
    const raced = await Promise.all([
      h.app(
        ev("POST", `/sites/${s.id}/deploys/${d1.id}/commit`, {
          headers: alice.cookie,
        }),
      ),
      h.app(
        ev("POST", `/sites/${s.id}/deploys/${d1.id}/commit`, {
          headers: alice.cookie,
        }),
      ),
    ]);
    // The winner answers 202; the loser either sees the queued row (202) or
    // loses the same-second claim (409) — never releases the winner's claim.
    expect(raced.map((r) => r.statusCode).sort()).toEqual(
      expect.arrayContaining([202]),
    );
    expect(
      raced.every((r) => r.statusCode === 202 || r.statusCode === 409),
    ).toBe(true);
    expect((await h.sites.findSite(s.id))?.activeDeployId).toBe(d1.id);
    expect(h.invoked.filter((x) => x === d1.id)).toHaveLength(2);

    const done = await work(h, d1.id);
    expect(done).toMatchObject({ status: "live", files: 3, error: null });
    expect(done!.bytes).toBeGreaterThan(0);
    const keys = [...h.siteStore.objects.keys()].sort();
    expect(keys).toEqual([
      `${s.slug}/assets/index-B3xk9Qz1.js`,
      `${s.slug}/config.json`,
      `${s.slug}/index.html`,
    ]);
    expect(h.siteStore.objects.get(`${s.slug}/index.html`)!.headers).toEqual({
      contentType: "text/html; charset=utf-8",
      cacheControl: "no-cache",
    });
    expect(h.siteStore.invalidations).toEqual([[`/${s.slug}/*`]]);
    expect(h.siteStore.deletedZips).toEqual([siteStagingKey(d1.id)]);
    const view = parse(
      await h.app(ev("GET", `/sites/${s.id}`, { headers: alice.cookie })),
    );
    expect(view).toMatchObject({
      currentDeployId: d1.id,
      busy: false,
      currentDeploy: { id: d1.id, status: "live" },
    });
    // The failed second attempt is in the history, the live one first.
    expect(view.deploys.map((d: { status: string }) => d.status)).toEqual([
      "pending",
      "live",
    ]);
    // A live deploy's commit answers 200 with the row.
    expect(
      (
        await h.app(
          ev("POST", `/sites/${s.id}/deploys/${d1.id}/commit`, {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(200);

    // Second deploy drops config.json: the prune removes it, index is replaced.
    const zip2 = makeZip([
      { name: "index.html", data: "two" },
      { name: "assets/index-Q9z8y7x6.js", data: "2" },
    ]);
    const c2 = await deploy(h, alice, s.id, zip2);
    expect(c2.statusCode, c2.body).toBe(202);
    const d2 = parse(c2);
    expect(await work(h, d2.id)).toMatchObject({ status: "live", files: 2 });
    expect([...h.siteStore.objects.keys()].sort()).toEqual([
      `${s.slug}/assets/index-Q9z8y7x6.js`,
      `${s.slug}/index.html`,
    ]);
    expect(
      h.siteStore.objects.get(`${s.slug}/index.html`)!.body.toString(),
    ).toBe("two");
    expect(
      parse(await h.app(ev("GET", `/sites/${s.id}`, { headers: alice.cookie })))
        .currentDeployId,
    ).toBe(d2.id);
    // Deploy detail route and the wrong-site 404.
    expect(
      parse(
        await h.app(
          ev("GET", `/sites/${s.id}/deploys/${d2.id}`, {
            headers: alice.cookie,
          }),
        ),
      ).status,
    ).toBe("live");
    const other = await mkSite(h, alice, "other");
    expect(
      (
        await h.app(
          ev("GET", `/sites/${other.id}/deploys/${d2.id}`, {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
  });

  it("refuses a bad upload at commit and records worker failures on the row", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const s = await mkSite(h, alice);
    // Not uploaded.
    expect(
      (await deploy(h, alice, s.id, siteZip(), { skipPut: true })).statusCode,
    ).toBe(400);
    // Wrong type, bigger than granted.
    expect(
      (await deploy(h, alice, s.id, siteZip(), { contentType: "text/html" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await deploy(h, alice, s.id, siteZip(), { size: 10 })).statusCode,
    ).toBe(400);
    // Over the cap at grant time.
    expect(
      (
        await h.app(
          ev("POST", `/sites/${s.id}/deploys`, {
            body: { size: SITE_MAX_ZIP_BYTES + 1 },
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(400);
    // The site is not busy after refused commits.
    expect(
      parse(await h.app(ev("GET", `/sites/${s.id}`, { headers: alice.cookie })))
        .busy,
    ).toBe(false);

    // A zip that escapes: the worker fails the row, frees the site, drops the zip.
    const evil = makeZip([
      { name: "index.html", data: "x" },
      { name: "../victim/index.html", data: "pwn" },
    ]);
    const c = await deploy(h, alice, s.id, evil);
    expect(c.statusCode).toBe(202);
    const id = parse(c).id;
    expect(await work(h, id)).toMatchObject({
      status: "failed",
      error: "zip_path_rejected: ../victim/index.html",
    });
    expect(h.siteStore.objects.size).toBe(0);
    expect(h.siteStore.deletedZips).toContain(siteStagingKey(id));
    expect(
      parse(await h.app(ev("GET", `/sites/${s.id}`, { headers: alice.cookie })))
        .busy,
    ).toBe(false);
    // A failed deploy cannot be committed again; a new one can.
    expect(
      (
        await h.app(
          ev("POST", `/sites/${s.id}/deploys/${id}/commit`, {
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(409);
    expect((await deploy(h, alice, s.id, siteZip())).statusCode).toBe(202);
  });

  it("storage and CDN failures end in failed, never in a stuck row", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const s = await mkSite(h, alice);
    const a = parse(await deploy(h, alice, s.id, siteZip()));
    h.siteStore.failNext("putFile");
    expect(await work(h, a.id)).toMatchObject({
      status: "failed",
      error: "storage_error",
    });
    const b = parse(await deploy(h, alice, s.id, siteZip()));
    h.siteStore.failNext("invalidate");
    // The tree was already replaced: live, with the CDN miss as a warning.
    expect(await work(h, b.id)).toMatchObject({
      status: "live",
      error: "cdn_invalidation_failed",
    });
    expect(h.siteStore.objects.size).toBe(3);
    expect(
      parse(await h.app(ev("GET", `/sites/${s.id}`, { headers: alice.cookie })))
        .currentDeployId,
    ).toBe(b.id);
    const c = parse(await deploy(h, alice, s.id, siteZip()));
    expect(await work(h, c.id)).toMatchObject({ status: "live", error: null });
    // A staging zip that vanished is `zip_missing`, any other storage failure
    // a `storage_error` — never confused with each other.
    const g = parse(await deploy(h, alice, s.id, siteZip()));
    h.siteStore.zips.clear();
    expect(await work(h, g.id)).toMatchObject({
      status: "failed",
      error: "zip_missing",
    });
    const g2 = parse(await deploy(h, alice, s.id, siteZip()));
    h.siteStore.failNext("getZip");
    expect(await work(h, g2.id)).toMatchObject({
      status: "failed",
      error: "storage_error",
    });
    expect(
      errorText("zip_path_rejected", "caf\u00e9\u0000" + "x".repeat(200)),
    ).toBe(`zip_path_rejected: caf??${"x".repeat(115)}`);
    // A worker event for an unknown or already-judged deploy is a no-op.
    expect(await work(h, "sd_nope")).toBeUndefined();
    expect(await work(h, c.id)).toMatchObject({ status: "live" });
    // Without a distribution id the deploy still goes live (edge is stale).
    const store2 = createMemorySiteStore();
    const sites2 = createMemorySitesDb();
    await sites2.insertSite({
      id: "st_x",
      name: "x",
      slug: "abcdefghi",
      teamId: "t",
      projectId: "p",
      createdAt: 1,
    });
    await sites2.insertDeploy({
      id: "sd_x",
      siteId: "st_x",
      zipBytes: 1,
      objectKey: "k",
      createdAt: 1,
      expiresAt: 9,
    });
    await sites2.claimSite("st_x", "sd_x", 1);
    await sites2.transitionDeploy("sd_x", "pending", { status: "queued" }, 1);
    store2.stageZip("k", siteZip());
    expect(
      await runSiteDeploy("sd_x", {
        sites: sites2,
        store: store2,
        logger: nullLogger,
      }),
    ).toMatchObject({ status: "live" });
    expect(store2.invalidations).toEqual([]);
  });

  it("heals a deploy whose worker died on the next read and in the sweep", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const s = await mkSite(h, alice);
    const d = parse(await deploy(h, alice, s.id, siteZip()));
    // The worker never ran: a `queued` row waits out the long window (it may
    // be behind other deploys in Lambda's queue), an `extracting` one the short.
    h.clock.tick(SITE_STALE_SEC + 10);
    expect(
      parse(await h.app(ev("GET", `/sites/${s.id}`, { headers: alice.cookie })))
        .busy,
    ).toBe(true);
    h.clock.tick(SITE_QUEUED_STALE_SEC - SITE_STALE_SEC);
    const view = parse(
      await h.app(ev("GET", `/sites/${s.id}`, { headers: alice.cookie })),
    );
    expect(view.busy).toBe(false);
    expect(view.deploys[0]).toMatchObject({
      id: d.id,
      status: "failed",
      error: "worker_lost",
    });
    // A late worker for the healed deploy does nothing.
    expect(await work(h, d.id)).toMatchObject({ status: "failed" });
    // The sweep: expired pending grants lose their row and zip; stale rows heal.
    const g = await h.app(
      ev("POST", `/sites/${s.id}/deploys`, {
        body: { size: 5 },
        headers: alice.cookie,
      }),
    );
    const pendingId = parse(g).deployId;
    h.siteStore.stageZip(siteStagingKey(pendingId), Buffer.from("zzzzz"));
    const e = parse(await deploy(h, alice, s.id, siteZip()));
    // Move it to `extracting` by hand: the short window applies.
    await h.sites.transitionDeploy(
      e.id,
      "queued",
      { status: "extracting" },
      NOW_SEC,
    );
    // An orphan zip nothing names (its site was deleted) and a fresh one.
    h.siteStore.stageZip(
      siteStagingKey("sd_orphan"),
      Buffer.from("old"),
      "application/zip",
      NOW_SEC - 10,
    );
    h.siteStore.stageZip(
      siteStagingKey("sd_fresh"),
      Buffer.from("new"),
      "application/zip",
      NOW_SEC + 4000,
    );
    h.clock.tick(SITE_STAGING_GRACE_SEC + 1);
    const r = await runSiteSweep({
      sites: h.sites,
      store: h.siteStore,
      clock: h.clock,
      logger: nullLogger,
    });
    // Orphans: the healed deploy `d` (its zip was never read) and sd_orphan.
    expect(r).toEqual({ expired: 1, orphans: 2, healed: 1 });
    expect(h.siteStore.deletedZips).toContain(siteStagingKey(d.id));
    expect(await h.sites.findDeploy(pendingId)).toBeUndefined();
    expect(h.siteStore.deletedZips).toContain(siteStagingKey(pendingId));
    expect(h.siteStore.deletedZips).toContain(siteStagingKey("sd_orphan"));
    expect(h.siteStore.zips.has(siteStagingKey("sd_fresh"))).toBe(true);
    expect((await h.sites.findDeploy(e.id))?.status).toBe("failed");
    expect(
      await healStaleDeploys({
        sites: h.sites,
        clock: h.clock,
        logger: nullLogger,
      }),
    ).toBe(0);
  });

  it("deletes the prefix, invalidates and refuses while a deploy holds the site", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const s = await mkSite(h, alice);
    const d = parse(await deploy(h, alice, s.id, siteZip()));
    expect(
      (await h.app(ev("DELETE", `/sites/${s.id}`, { headers: alice.cookie })))
        .statusCode,
    ).toBe(409);
    await work(h, d.id);
    // Another site's objects survive the delete of this one.
    const other = await mkSite(h, alice, "other");
    const od = parse(await deploy(h, alice, other.id, siteZip("o")));
    await work(h, od.id);
    h.siteStore.failNext("deleteKeys");
    expect(
      (await h.app(ev("DELETE", `/sites/${s.id}`, { headers: alice.cookie })))
        .statusCode,
    ).toBe(503);
    // The failed delete released its claim: the site is usable again.
    expect(
      parse(await h.app(ev("GET", `/sites/${s.id}`, { headers: alice.cookie })))
        .busy,
    ).toBe(false);
    expect(
      (await h.app(ev("DELETE", `/sites/${s.id}`, { headers: alice.cookie })))
        .statusCode,
    ).toBe(204);
    expect(
      [...h.siteStore.objects.keys()].every((k) =>
        k.startsWith(`${other.slug}/`),
      ),
    ).toBe(true);
    expect(h.siteStore.objects.size).toBe(3);
    expect(h.siteStore.invalidations.at(-1)).toEqual([`/${s.slug}/*`]);
    expect(
      (await h.app(ev("GET", `/sites/${s.id}`, { headers: alice.cookie })))
        .statusCode,
    ).toBe(404);
    expect(await h.sites.findDeploy(d.id)).toBeUndefined();

    // A delete that died holding the claim is healed by the next read.
    const dead = await mkSite(h, alice, "dead");
    await h.sites.claimSite(dead.id, SITE_DELETING, NOW_SEC);
    const busyOf = async (id: string) =>
      parse(await h.app(ev("GET", `/sites/${id}`, { headers: alice.cookie })))
        .busy as boolean;
    expect(await busyOf(dead.id)).toBe(true);
    h.clock.tick(SITE_STALE_SEC + 1);
    expect(await busyOf(dead.id)).toBe(false);
    // Deleting a site with pending grants drops their staging zips too.
    const gsite = await mkSite(h, alice, "grants");
    const g = await h.app(
      ev("POST", `/sites/${gsite.id}/deploys`, {
        body: { size: 5 },
        headers: alice.cookie,
      }),
    );
    h.siteStore.stageZip(
      siteStagingKey(parse(g).deployId),
      Buffer.from("zzzzz"),
    );
    expect(
      (
        await h.app(
          ev("DELETE", `/sites/${gsite.id}`, { headers: alice.cookie }),
        )
      ).statusCode,
    ).toBe(204);
    expect(h.siteStore.deletedZips).toContain(
      siteStagingKey(parse(g).deployId),
    );
    // An empty site's delete buys no invalidation.
    const empty = await mkSite(h, alice, "empty");
    const before = h.siteStore.invalidations.length;
    expect(
      (
        await h.app(
          ev("DELETE", `/sites/${empty.id}`, { headers: alice.cookie }),
        )
      ).statusCode,
    ).toBe(204);
    expect(h.siteStore.invalidations.length).toBe(before);

    // A deploy racing a delete: the worker sees the claim gone and stops.
    const t = await mkSite(h, alice, "third");
    const td = parse(await deploy(h, alice, t.id, siteZip()));
    // Simulate the delete taking over after the worker was queued.
    await h.sites.releaseSite(t.id, td.id, NOW_SEC);
    await h.sites.claimSite(t.id, SITE_DELETING, NOW_SEC);
    expect(await work(h, td.id)).toMatchObject({
      status: "failed",
      error: "site_gone",
    });
  });

  it("rate-limits deploy grants per site and answers 503 without storage", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const s = await mkSite(h, alice);
    for (let i = 0; i < SITE_DEPLOYS_PER_HOUR; i++) {
      h.clock.tick(1);
      const g = await h.app(
        ev("POST", `/sites/${s.id}/deploys`, {
          body: { size: 5 },
          headers: alice.cookie,
        }),
      );
      expect(g.statusCode, String(i)).toBe(201);
    }
    expect(
      (
        await h.app(
          ev("POST", `/sites/${s.id}/deploys`, {
            body: { size: 5 },
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(429);
    h.clock.tick(3600);
    expect(
      (
        await h.app(
          ev("POST", `/sites/${s.id}/deploys`, {
            body: { size: 5 },
            headers: alice.cookie,
          }),
        )
      ).statusCode,
    ).toBe(201);
    // Per member across sites: spreading grants over many sites does not help.
    h.clock.tick(3600);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++)
      ids.push((await mkSite(h, alice, `many-${i}`)).id);
    let granted = 0;
    let limited = 0;
    for (let i = 0; i < SITE_DEPLOYS_PER_MEMBER_HOUR + 5; i++) {
      h.clock.tick(1);
      const r = await h.app(
        ev("POST", `/sites/${ids[i % ids.length]!}/deploys`, {
          body: { size: 5 },
          headers: alice.cookie,
        }),
      );
      if (r.statusCode === 201) granted++;
      else if (r.statusCode === 429) limited++;
    }
    expect(granted).toBe(SITE_DEPLOYS_PER_MEMBER_HOUR);
    expect(limited).toBe(5);

    const bare = harness({ siteStore: undefined, siteInvoke: undefined });
    const bob = await bare.team("bob");
    const b = await mkSite(bare, bob);
    expect(
      (
        await bare.app(
          ev("POST", `/sites/${b.id}/deploys`, {
            body: { size: 5 },
            headers: bob.cookie,
          }),
        )
      ).statusCode,
    ).toBe(503);
    // An empty site is still deletable without storage.
    expect(
      (await bare.app(ev("DELETE", `/sites/${b.id}`, { headers: bob.cookie })))
        .statusCode,
    ).toBe(503);
  });

  it("mints unbiased lowercase slugs", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const slug = mintSlug();
      expect(slug).toMatch(/^[a-z0-9]{9}$/);
      seen.add(slug);
    }
    expect(seen.size).toBe(200);
    // Rejection sampling: bytes ≥ 252 are skipped, the rest map mod 36.
    let n = 0;
    const seq = [255, 252, 0, 35, 36, 251, 1, 2, 3, 4, 5, 6];
    expect(mintSlug(() => seq[n++ % seq.length]!)).toBe("a9a9bcdef");
  });
});

/** Moves every recorded release back by `sec` (a session would not survive the clock). */
function age(h: H, sec: number) {
  for (const [k, r] of h.sites.names)
    if (r.releasedAt !== null)
      h.sites.names.set(k, { ...r, releasedAt: r.releasedAt - sec });
}

describe("site names (docs/decisions.md *Site domains*)", () => {
  const patch = (h: H, u: Team, siteId: string, body: unknown) =>
    h.app(ev("PATCH", `/sites/${siteId}`, { body, headers: u.cookie }));
  const get = async (h: H, u: Team, siteId: string) =>
    parse(await h.app(ev("GET", `/sites/${siteId}`, { headers: u.cookie })));

  it("claims a name on an empty site at once; URLs and host follow the slug", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const s = await mkSite(h, alice);
    expect(s).toMatchObject({
      domain: null,
      hostUrl: `https://${s.slug}.${SITE_HOST}/`,
      hostSuffix: SITE_HOST,
      movingTo: null,
    });
    const r = await patch(h, alice, s.id, { domain: "  My-Game " });
    expect(r.statusCode, r.body).toBe(200);
    expect(parse(r)).toMatchObject({
      slug: "my-game",
      domain: "my-game",
      publicUrl: `${SITE_CDN}/my-game/`,
      basePath: "/my-game/",
      hostUrl: `https://my-game.${SITE_HOST}/`,
      busy: false,
    });
    expect(h.invoked).toEqual([]);
    // The same name again is a no-op and takes no slot.
    expect(
      (await patch(h, alice, s.id, { domain: "my-game" })).statusCode,
    ).toBe(200);
    // An empty random slug never served: nothing to remember.
    expect(await h.sites.findSiteName(s.slug)).toBeUndefined();
    // The rename is a move row, so the deploy budgets count it.
    expect((await get(h, alice, s.id)).deploys[0]).toMatchObject({
      kind: "move",
      status: "live",
      moveTo: "my-game",
      moveFrom: s.slug,
    });
  });

  it("validates before it spends the team's one request per second", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const s = await mkSite(h, alice);
    for (const bad of [
      "ab",
      "a".repeat(33),
      "-ab",
      "ab-",
      "a--b",
      "xn--abc",
      "a_b",
      "a.b",
      "www",
      "console-dev",
      "dev-g",
      "my-login",
      "console",
      "yyt-game",
      "yingyeothon",
    ]) {
      const r = await patch(h, alice, s.id, { domain: bad });
      expect(r.statusCode, bad).toBe(400);
    }
    // No 400 above spent the slot: this one passes in the same second.
    expect((await patch(h, alice, s.id, { domain: "abc" })).statusCode).toBe(
      200,
    );
    // Any site of the team, same second: 429 with a retry hint; nothing moved.
    const s2 = await mkSite(h, alice, "web2");
    const busy = await patch(h, alice, s2.id, { domain: "def" });
    expect(busy.statusCode).toBe(429);
    expect(parse(busy).error.details).toEqual({ retryAfterMs: 1000 });
    expect((await h.sites.findSite(s2.id))?.slug).toBe(s2.slug);
    expect(await h.kv.ttl("sdrl:" + alice.teamId)).toBe(1);
    // Another team is not affected.
    const bob = await h.team("bob");
    const b = await mkSite(h, bob);
    expect((await patch(h, bob, b.id, { domain: "ghi" })).statusCode).toBe(200);
    // A name/description-only patch is never gated.
    expect(
      (await patch(h, alice, s2.id, { description: "x" })).statusCode,
    ).toBe(200);
    h.clock.tick(1);
    expect((await patch(h, alice, s2.id, { domain: "def" })).statusCode).toBe(
      200,
    );
  });

  it("moves a deployed site through the worker (202) and keeps the headers", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const s = await mkSite(h, alice);
    const c = await deploy(h, alice, s.id, siteZip());
    await work(h, parse(c).id);
    const old = s.slug as string;
    const files = ["assets/index-B3xk9Qz1.js", "config.json", "index.html"];
    expect([...h.siteStore.objects.keys()].sort()).toEqual(
      files.map((f) => `${old}/${f}`),
    );
    // A later second than the upload, so the deploy list order is fixed.
    h.clock.tick(1);
    const r = await patch(h, alice, s.id, { domain: "my-game" });
    expect(r.statusCode, r.body).toBe(202);
    expect(parse(r)).toMatchObject({
      slug: old,
      busy: true,
      movingTo: "my-game",
      domain: null,
    });
    const moveId = h.invoked.at(-1)!;
    // Busy for deploys and for another name request.
    h.clock.tick(1);
    expect((await patch(h, alice, s.id, { domain: "other" })).statusCode).toBe(
      409,
    );
    const done = await work(h, moveId);
    expect(done).toMatchObject({
      status: "live",
      moveTo: "my-game",
      files: 3,
      error: null,
    });
    expect([...h.siteStore.objects.keys()].sort()).toEqual(
      files.map((f) => `my-game/${f}`),
    );
    expect(h.siteStore.objects.get("my-game/index.html")?.headers).toEqual({
      contentType: "text/html; charset=utf-8",
      cacheControl: "no-cache",
    });
    expect(h.siteStore.invalidations.at(-1)).toEqual([`/${old}/*`]);
    const after = await get(h, alice, s.id);
    expect(after).toMatchObject({
      slug: "my-game",
      domain: "my-game",
      busy: false,
      movingTo: null,
      currentDeployId: parse(c).id,
    });
    expect(after.deploys[0]).toMatchObject({ id: moveId, moveTo: "my-game" });
    // Clearing moves back to a fresh random slug; the name stays recorded.
    h.clock.tick(1);
    const back = await patch(h, alice, s.id, { domain: null });
    expect(back.statusCode).toBe(202);
    const target = parse(back).movingTo as string;
    expect(target).toMatch(/^[a-z0-9]{9}$/);
    expect(target).not.toBe(old);
    await work(h, h.invoked.at(-1)!);
    expect(await get(h, alice, s.id)).toMatchObject({
      slug: target,
      domain: null,
    });
    expect(await h.sites.findSiteName("my-game")).toMatchObject({
      teamId: alice.teamId,
      releasedAt: expect.any(Number),
    });
  });

  it("a served name never passes to another team; the same team reclaims it", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const bob = await h.team("bob");
    const a = await mkSite(h, alice);
    const b = await mkSite(h, bob);
    // Served: files moved under the name.
    await work(h, parse(await deploy(h, alice, a.id, siteZip())).id);
    h.clock.tick(1);
    expect((await patch(h, alice, a.id, { domain: "shared" })).statusCode).toBe(
      202,
    );
    await work(h, h.invoked.at(-1)!);
    const taken = await patch(h, bob, b.id, { domain: "shared" });
    expect(taken.statusCode).toBe(409);
    expect(parse(taken).error.details).toEqual({ reason: "domain_taken" });
    // The random slug the move left behind served too.
    h.clock.tick(1);
    expect((await patch(h, bob, b.id, { domain: a.slug })).statusCode).toBe(
      409,
    );
    // Deleted: still alice's, forever, and already emptied.
    expect(
      (await h.app(ev("DELETE", `/sites/${a.id}`, { headers: alice.cookie })))
        .statusCode,
    ).toBe(204);
    expect(await h.sites.findSiteName("shared")).toMatchObject({
      teamId: alice.teamId,
      served: true,
      purgedAt: expect.any(Number),
    });
    age(h, 40 * 86400);
    h.clock.tick(1);
    expect((await patch(h, bob, b.id, { domain: "shared" })).statusCode).toBe(
      409,
    );
    const a2 = await mkSite(h, alice, "web2");
    expect(
      (await patch(h, alice, a2.id, { domain: "shared" })).statusCode,
    ).toBe(200);
    // A name that never served goes free when it is let go.
    h.clock.tick(1);
    expect((await patch(h, bob, b.id, { domain: "brief" })).statusCode).toBe(
      200,
    );
    h.clock.tick(1);
    expect((await patch(h, bob, b.id, { domain: null })).statusCode).toBe(200);
    expect(await h.sites.findSiteName("brief")).toBeUndefined();
    // A prefix holding objects nobody recorded (a hand-published game) is
    // recorded as nobody's on first sight.
    await h.siteStore.putFile("legacy-game/index.html", Buffer.from("x"), {
      contentType: "text/html",
      cacheControl: "no-cache",
    });
    h.clock.tick(1);
    expect(
      parse(await patch(h, bob, b.id, { domain: "legacy-game" })).error.details,
    ).toEqual({ reason: "domain_taken" });
    expect(await h.sites.findSiteName("legacy-game")).toMatchObject({
      teamId: null,
      served: true,
    });
  });

  it("caps a team at 20 counted names; renames spend the deploy budget", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      h.clock.tick(1);
      const s = await mkSite(h, alice, `web${i}`);
      ids.push(s.id);
      const r = await patch(h, alice, s.id, { domain: `name-${i}` });
      expect(r.statusCode, r.body).toBe(200);
    }
    const extra = await mkSite(h, alice, "extra");
    h.clock.tick(1);
    const full = await patch(h, alice, extra.id, { domain: "name-20" });
    expect(full.statusCode).toBe(409);
    const details = parse(full).error.details;
    expect(details.reason).toBe("domain_cap");
    expect(details.names).toHaveLength(20);
    // Letting go of a name that never served frees a slot.
    h.clock.tick(1);
    expect((await patch(h, alice, ids[3]!, { domain: null })).statusCode).toBe(
      200,
    );
    h.clock.tick(1);
    expect(
      (await patch(h, alice, extra.id, { domain: "name-20" })).statusCode,
    ).toBe(200);
    // Twenty renames of one site in an hour is the per-site deploy cap.
    const bob = await h.team("bob");
    const one = await mkSite(h, bob, "busy-site");
    let last: number | undefined = 0;
    for (let i = 0; i < 21; i++) {
      h.clock.tick(1);
      last = (await patch(h, bob, one.id, { domain: i % 2 ? null : "flip" }))
        .statusCode;
      if (last !== 200) break;
    }
    expect(last).toBe(429);
  });

  it("an admin releases a recorded name; members cannot", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const bob = await h.team("bob");
    const a = await mkSite(h, alice);
    await work(h, parse(await deploy(h, alice, a.id, siteZip())).id);
    h.clock.tick(1);
    await patch(h, alice, a.id, { domain: "squat" });
    await work(h, h.invoked.at(-1)!);
    const boss = await h.login("Boss", "admin");
    const release = (u: { cookie: Record<string, string> }, body: unknown) =>
      h.app(
        ev("POST", "/admin/site-names/squat/release", {
          body,
          headers: u.cookie,
        }),
      );
    expect((await release(alice, { reason: "x" })).statusCode).toBe(403);
    expect((await release(boss, {})).statusCode).toBe(400);
    // In use by a site: refused.
    expect((await release(boss, { reason: "abuse" })).statusCode).toBe(409);
    expect(
      (await h.app(ev("DELETE", `/sites/${a.id}`, { headers: alice.cookie })))
        .statusCode,
    ).toBe(204);
    expect(
      parse(
        await h.app(
          ev("GET", "/admin/site-names/squat", { headers: boss.cookie }),
        ),
      ),
    ).toMatchObject({ name: "squat", teamId: alice.teamId, served: true });
    expect((await release(boss, { reason: "abuse" })).statusCode).toBe(204);
    expect(await h.sites.findSiteName("squat")).toBeUndefined();
    const b = await mkSite(h, bob);
    h.clock.tick(1);
    expect((await patch(h, bob, b.id, { domain: "squat" })).statusCode).toBe(
      200,
    );
    expect(
      (
        await h.app(
          ev("GET", "/admin/site-names/nope", { headers: boss.cookie }),
        )
      ).statusCode,
    ).toBe(404);
  });

  it("gates like every write: seatless admin 403, outsider 404", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const s = await mkSite(h, alice);
    const boss = await h.login("Boss", "admin");
    expect(
      (
        await h.app(
          ev("PATCH", `/sites/${s.id}`, {
            body: { domain: "abc" },
            headers: boss.cookie,
          }),
        )
      ).statusCode,
    ).toBe(403);
    const eve = await h.team("eve");
    expect((await patch(h, eve, s.id, { domain: "abc" })).statusCode).toBe(404);
  });

  it("a stage without the per-site host still renames; host fields are null", async () => {
    const h = harness({ siteHostSuffix: undefined });
    const alice = await h.team("alice");
    const s = await mkSite(h, alice);
    expect(s).toMatchObject({ hostUrl: null, hostSuffix: null });
    expect(
      parse(await patch(h, alice, s.id, { domain: "plain" })),
    ).toMatchObject({ publicUrl: `${SITE_CDN}/plain/`, hostUrl: null });
  });

  it("a failed invoke or a lost worker releases the target", async () => {
    const h = harness({
      siteInvoke: async () => {
        throw new Error("boom");
      },
    });
    const alice = await h.team("alice");
    const s = await mkSite(h, alice);
    await h.siteStore.putFile(`${s.slug}/index.html`, Buffer.from("x"), {
      contentType: "text/html",
      cacheControl: "no-cache",
    });
    expect((await patch(h, alice, s.id, { domain: "lost" })).statusCode).toBe(
      503,
    );
    expect(await h.sites.findSite(s.id)).toMatchObject({
      slug: s.slug,
      activeDeployId: null,
    });
    // Nothing was copied: the name never served and is free again at once.
    expect(await h.sites.findSiteName("lost")).toBeUndefined();

    // A move nobody runs: the heal fails it and releases the name.
    const h2 = harness();
    const bob = await h2.team("bob");
    const b = await mkSite(h2, bob);
    await h2.siteStore.putFile(`${b.slug}/index.html`, Buffer.from("x"), {
      contentType: "text/html",
      cacheControl: "no-cache",
    });
    expect((await patch(h2, bob, b.id, { domain: "stuck" })).statusCode).toBe(
      202,
    );
    h2.clock.tick(SITE_QUEUED_STALE_SEC + 1);
    expect(
      await healStaleDeploys({
        sites: h2.sites,
        clock: h2.clock,
        logger: nullLogger,
      }),
    ).toBe(1);
    expect(await h2.sites.findSiteName("stuck")).toMatchObject({
      releasedAt: expect.any(Number),
    });
    expect(await get(h2, bob, b.id)).toMatchObject({
      slug: b.slug,
      busy: false,
    });
  });

  it("a move that fails mid-copy deletes only what it wrote", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const s = await mkSite(h, alice);
    const c = await deploy(h, alice, s.id, siteZip());
    await work(h, parse(c).id);
    expect((await patch(h, alice, s.id, { domain: "half" })).statusCode).toBe(
      202,
    );
    h.siteStore.failNext("copyKey");
    const r = await work(h, h.invoked.at(-1)!);
    expect(r).toMatchObject({ status: "failed", error: "storage_error" });
    expect(
      [...h.siteStore.objects.keys()].filter((k) => k.startsWith("half/")),
    ).toEqual([]);
    expect(
      [...h.siteStore.objects.keys()].filter((k) => k.startsWith(`${s.slug}/`)),
    ).toHaveLength(3);
    expect(await h.sites.findSite(s.id)).toMatchObject({
      slug: s.slug,
      activeDeployId: null,
    });
  });
});

describe("site moves: crash paths and the purge sweep", () => {
  const patch = (h: H, u: Team, siteId: string, body: unknown) =>
    h.app(ev("PATCH", `/sites/${siteId}`, { body, headers: u.cookie }));
  const keysUnder = (h: H, prefix: string) =>
    [...h.siteStore.objects.keys()].filter((k) => k.startsWith(`${prefix}/`));
  /** A deployed site with a move to `name` queued; returns the move id. */
  async function queuedMove(h: H, u: Team, name: string) {
    const s = await mkSite(h, u, `web-${name}`);
    await work(h, parse(await deploy(h, u, s.id, siteZip())).id);
    h.clock.tick(1);
    const r = await patch(h, u, s.id, { domain: name });
    expect(r.statusCode, r.body).toBe(202);
    return { site: s, moveId: h.invoked.at(-1)! };
  }

  it("a lost reply after the switch commits still counts as switched", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const { site, moveId } = await queuedMove(h, alice, "lost-reply");
    const real = h.sites.completeSiteMove.bind(h.sites);
    h.sites.completeSiteMove = async (...a) => {
      await real(...a);
      throw new Error("connection reset");
    };
    const done = await work(h, moveId);
    expect(done).toMatchObject({ status: "live" });
    expect((await h.sites.findSite(site.id))?.slug).toBe("lost-reply");
    expect(keysUnder(h, "lost-reply")).toHaveLength(3);
    expect(keysUnder(h, site.slug)).toEqual([]);
  });

  it("a move that runs out of time stops copying and removes what it wrote", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const { site, moveId } = await queuedMove(h, alice, "late");
    let calls = 0;
    const done = await runSiteDeploy(moveId, {
      sites: h.sites,
      store: h.siteStore,
      clock: h.clock,
      logger: nullLogger,
      concurrency: 1,
      remainingMs: () => (++calls > 1 ? 1000 : 300_000),
    });
    expect(done).toMatchObject({ status: "failed", error: "move_deadline" });
    expect(keysUnder(h, "late")).toEqual([]);
    expect(keysUnder(h, site.slug)).toHaveLength(3);
    // The target served copies for a moment: it stays the team's, emptied.
    expect(await h.sites.findSiteName("late")).toMatchObject({
      served: true,
      purgedAt: expect.any(Number),
    });
  });

  it("heal and sweep: a worker lost after the switch, and one lost mid-copy", async () => {
    const h = harness();
    const alice = await h.team("alice");
    // After the switch: the slug moved, the old tree is left.
    const a = await queuedMove(h, alice, "switched");
    await h.sites.transitionDeploy(
      a.moveId,
      "queued",
      { status: "extracting" },
      NOW_SEC,
    );
    for (const k of keysUnder(h, a.site.slug))
      await h.siteStore.copyKey(k, k.replace(`${a.site.slug}/`, "switched/"));
    await h.sites.completeSiteMove(a.site.id, a.moveId, NOW_SEC);
    // Mid-copy: one object landed under the target, the slug did not move.
    const b = await queuedMove(h, alice, "halfway");
    await h.sites.transitionDeploy(
      b.moveId,
      "queued",
      { status: "extracting" },
      NOW_SEC,
    );
    await h.siteStore.copyKey(
      `${b.site.slug}/index.html`,
      "halfway/index.html",
    );
    h.clock.tick(SITE_STALE_SEC + 1);
    expect(
      await healStaleDeploys({
        sites: h.sites,
        clock: h.clock,
        logger: nullLogger,
      }),
    ).toBe(2);
    expect(await h.sites.findDeploy(a.moveId)).toMatchObject({
      status: "live",
      error: "cleanup_failed",
    });
    expect(await h.sites.findDeploy(b.moveId)).toMatchObject({
      status: "failed",
      error: "worker_lost",
    });
    // Both leftovers are served by the lookup-free host until the sweep runs.
    expect(keysUnder(h, a.site.slug)).toHaveLength(3);
    expect(keysUnder(h, "halfway")).toHaveLength(1);
    const swept = await runSiteNameSweep({
      sites: h.sites,
      store: h.siteStore,
      clock: h.clock,
      logger: nullLogger,
    });
    expect(swept).toEqual({ purged: 2, failed: 0, more: false });
    expect(keysUnder(h, a.site.slug)).toEqual([]);
    expect(keysUnder(h, "halfway")).toEqual([]);
    expect(keysUnder(h, "switched")).toHaveLength(3);
    // The old random slug served: kept for the team, stamped purged.
    expect(await h.sites.findSiteName(a.site.slug)).toMatchObject({
      served: true,
      purgedAt: expect.any(Number),
    });
    // The half-copied target never served: dropped, free again.
    expect(await h.sites.findSiteName("halfway")).toBeUndefined();
    expect(
      await runSiteNameSweep({
        sites: h.sites,
        store: h.siteStore,
        clock: h.clock,
        logger: nullLogger,
      }),
    ).toEqual({ purged: 0, failed: 0, more: false });
  });

  it("a claim over the team's own uncleaned prefix empties it first", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const { site, moveId } = await queuedMove(h, alice, "first");
    await work(h, moveId);
    // Pretend the old tree could not be deleted and was not purged.
    const old = site.slug as string;
    await h.siteStore.putFile(`${old}/stale.txt`, Buffer.from("x"), {
      contentType: "text/plain",
      cacheControl: "no-cache",
    });
    const row = (await h.sites.findSiteName(old))!;
    h.sites.names.set(old, { ...row, purgedAt: null });
    const other = await mkSite(h, alice, "web2");
    h.clock.tick(1);
    const r = await patch(h, alice, other.id, { domain: old });
    expect(r.statusCode, r.body).toBe(200);
    expect(keysUnder(h, old)).toEqual([]);
  });
});

describe("site names: review regressions", () => {
  const patch = (h: H, u: Team, siteId: string, body: unknown) =>
    h.app(ev("PATCH", `/sites/${siteId}`, { body, headers: u.cookie }));

  it("a delete that races a landed move empties the new prefix", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const s = await mkSite(h, alice, "racer");
    await work(h, parse(await deploy(h, alice, s.id, siteZip())).id);
    h.clock.tick(1);
    expect((await patch(h, alice, s.id, { domain: "doomed" })).statusCode).toBe(
      202,
    );
    // The DELETE read the site before the move landed.
    const real = h.sites.claimSite.bind(h.sites);
    h.sites.claimSite = async (...a) => {
      await work(h, h.invoked.at(-1)!);
      return real(...a);
    };
    const del = await h.app(
      ev("DELETE", `/sites/${s.id}`, { headers: alice.cookie }),
    );
    h.sites.claimSite = real;
    // The move held the claim when the DELETE started, so it was refused, or
    // it ran after the move and emptied the new prefix — never both halves.
    if (del.statusCode === 204) {
      expect(
        [...h.siteStore.objects.keys()].filter((k) => k.startsWith("doomed/")),
      ).toEqual([]);
      expect(await h.sites.findSiteName("doomed")).toMatchObject({
        served: true,
      });
    } else expect(del.statusCode).toBe(409);
  });

  it("a PATCH whose listing went stale is busy, not an orphaning rename", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const s = await mkSite(h, alice, "stale");
    // Another request renames the (empty) site between this one's read and
    // its transaction.
    const real = h.sites.renameSite.bind(h.sites);
    let raced = false;
    h.sites.renameSite = async (o) => {
      if (!raced) {
        raced = true;
        await real({ ...o, target: "first", moveId: "sd_race" });
      }
      return real(o);
    };
    const r = await patch(h, alice, s.id, { domain: "second" });
    h.sites.renameSite = real;
    expect(r.statusCode).toBe(409);
    expect((await h.sites.findSite(s.id))?.slug).toBe("first");
  });

  it("clearing while a move is in flight is busy, not a silent no-op", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const s = await mkSite(h, alice, "inflight");
    await work(h, parse(await deploy(h, alice, s.id, siteZip())).id);
    h.clock.tick(1);
    expect((await patch(h, alice, s.id, { domain: "target" })).statusCode).toBe(
      202,
    );
    h.clock.tick(1);
    const clear = await patch(h, alice, s.id, { domain: null });
    expect(clear.statusCode).toBe(409);
  });

  it("naming the current random slug keeps the URL and records the name", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const s = await mkSite(h, alice, "keep");
    const r = await patch(h, alice, s.id, { domain: s.slug });
    expect(r.statusCode, r.body).toBe(200);
    expect(parse(r)).toMatchObject({ slug: s.slug, domain: s.slug });
    expect(await h.sites.findSiteName(s.slug)).toMatchObject({
      kind: "name",
      releasedAt: null,
    });
  });

  it("a failed inline purge answers 409 domain_cleaning", async () => {
    const h = harness();
    const alice = await h.team("alice");
    const a = await mkSite(h, alice, "first-site");
    await work(h, parse(await deploy(h, alice, a.id, siteZip())).id);
    h.clock.tick(1);
    await patch(h, alice, a.id, { domain: "mine" });
    await work(h, h.invoked.at(-1)!);
    h.clock.tick(1);
    await patch(h, alice, a.id, { domain: null });
    await work(h, h.invoked.at(-1)!);
    // Pretend the move's cleanup of "mine" failed.
    const row = (await h.sites.findSiteName("mine"))!;
    h.sites.names.set("mine", { ...row, purgedAt: null });
    await h.siteStore.putFile("mine/stale.txt", Buffer.from("x"), {
      contentType: "text/plain",
      cacheControl: "no-cache",
    });
    const b = await mkSite(h, alice, "second-site");
    h.siteStore.failNext("deleteKeys");
    h.clock.tick(1);
    const r = await patch(h, alice, b.id, { domain: "mine" });
    expect(r.statusCode).toBe(409);
    expect(parse(r).error.details).toEqual({ reason: "domain_cleaning" });
  });

  it("per-member budgets outlive a deleted site", async () => {
    const h = harness();
    const alice = await h.team("alice");
    let last: number | undefined = 0;
    for (let i = 0; i < 35; i++) {
      h.clock.tick(1);
      const s = await mkSite(h, alice, `loop-${i}`);
      last = (await patch(h, alice, s.id, { domain: `claim-${i}` })).statusCode;
      await h.app(ev("DELETE", `/sites/${s.id}`, { headers: alice.cookie }));
      if (last !== 200) break;
    }
    // Thirty claims a day per member, even though every site is gone.
    expect(last).toBe(429);
  });
});
