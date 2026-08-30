/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it } from "vitest";
import { nullLogger } from "@yyt/core";
import { createMemorySitesDb } from "@yyt/console-db";
import { createMemorySiteStore } from "../src/site-store.js";
import {
  errorText,
  healStaleDeploys,
  runSiteDeploy,
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
import { ev, harness, NOW_SEC, parse, SITE_CDN, type Team } from "./helpers.js";
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
