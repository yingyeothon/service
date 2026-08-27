/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { describe, expect, it } from "vitest";
import { nullLogger } from "@yyt/core";
import {
  runExpire,
  runRedisAclReconcile,
  runRedisUsageReport,
} from "../src/expire.js";
import {
  REDIS_ISSUE_COOLDOWN_SEC,
  revokeChannelRedis,
} from "../src/channel-redis.js";
import { CHANNEL_DELETE_GRACE_SEC } from "../src/channels.js";
import {
  ev,
  harness,
  NOW_SEC,
  parse,
  REDIS_ENDPOINT,
  STAGE,
  type Json,
  type Team,
} from "./helpers.js";

let seq = 0;
async function qChannel(
  h: ReturnType<typeof harness>,
  u: Team,
): Promise<string> {
  const n = ++seq;
  const authChannelId = parse(
    await h.app(
      ev("POST", `/projects/${u.prjId}/channels`, {
        headers: u.cookie,
        body: { kind: "auth", name: `base-${n}`, config: { audience: "x" } },
      }),
    ),
  ).id as string;
  const q = await h.app(
    ev("POST", `/projects/${u.prjId}/channels`, {
      headers: u.cookie,
      body: { kind: "q", name: `q-${n}`, config: { authChannelId } },
    }),
  );
  expect(q.statusCode, q.body).toBe(201);
  return parse(q).id as string;
}

describe("participant redis credentials", () => {
  it("issues a scoped credential once, with the whole copyable block", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await qChannel(h, a);

    const before = parse(
      await h.app(
        ev("GET", `/channels/${id}/redis-user`, { headers: a.cookie }),
      ),
    );
    expect(before.issued).toBe(false);

    const r = await h.app(
      ev("POST", `/channels/${id}/redis-user`, { headers: a.cookie }),
    );
    expect(r.statusCode).toBe(200);
    // A one-time secret must never be cached by a proxy or the browser.
    expect(r.headers!["cache-control"]).toBe("no-store");
    const issued: Json = parse(r);
    expect(issued).toMatchObject({
      channelId: id,
      host: REDIS_ENDPOINT.host,
      port: REDIS_ENDPOINT.port,
      username: `game_${STAGE}_${id}`,
      // The four prefixes tslib's `handleActor` needs plus the pub/sub one:
      // anything the participant names themselves falls outside the ACL.
      eventKeyPrefix: `game:${STAGE}:${id}:event:`,
      queueKeyPrefix: `game:${STAGE}:${id}:queue:`,
      lockKeyPrefix: `game:${STAGE}:${id}:lock:`,
      awaiterKeyPrefix: `game:${STAGE}:${id}:awaiter:`,
      channelPrefix: `game:out:${STAGE}:${id}:`,
    });
    expect(issued.password).toMatch(/^[0-9a-f]{64}$/);
    expect(h.redisAcl.users.get(`game_${STAGE}_${id}`)).toEqual({
      keyPattern: `~game:${STAGE}:${id}:*`,
      channelPattern: `&game:out:${STAGE}:${id}:*`,
    });

    // Reading it back says "issued" but never returns the password again.
    const after: Json = parse(
      await h.app(
        ev("GET", `/channels/${id}/redis-user`, { headers: a.cookie }),
      ),
    );
    expect(after.issued).toBe(true);
    expect(after.password).toBeUndefined();
  });

  it("re-issuing replaces the credential rather than adding a second one", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await qChannel(h, a);
    const first = parse(
      await h.app(
        ev("POST", `/channels/${id}/redis-user`, { headers: a.cookie }),
      ),
    );
    h.clock.tick(REDIS_ISSUE_COOLDOWN_SEC + 1);
    const r = await h.app(
      ev("POST", `/channels/${id}/redis-user`, { headers: a.cookie }),
    );
    // Assert the status too: without it a 429 would make this pass vacuously,
    // `undefined !== <password>` being perfectly true.
    expect(r.statusCode).toBe(200);
    const second = parse(r);
    expect(second.password).toMatch(/^[0-9a-f]{64}$/);
    expect(second.password).not.toBe(first.password);
    expect(h.redisAcl.users.size).toBe(1);
  });

  it("rate-limits issuing, because every issue rewrites the whole aclfile", async () => {
    const h = harness();
    const a = await h.team("alice");
    const one = await qChannel(h, a);
    const two = await qChannel(h, a);
    const post = (id: string) =>
      h.app(ev("POST", `/channels/${id}/redis-user`, { headers: a.cookie }));
    expect((await post(one)).statusCode).toBe(200);
    // Per member: a second channel must not double the rate at which one
    // member can make Redis rewrite its ACL file.
    expect((await post(two)).statusCode).toBe(429);
    // The refusal lands before any work reaches Redis.
    expect(h.redisAcl.users.size).toBe(1);
    h.clock.tick(REDIS_ISSUE_COOLDOWN_SEC + 1);
    expect((await post(two)).statusCode).toBe(200);
    // And per channel: every team member may mint, so N teammates issuing the
    // same channel back to back would otherwise be N `ACL SAVE`s.
    const mate = await h.login("mate", "member");
    await h.seat(a, a.teamId, "mate");
    expect(
      (
        await h.app(
          ev("POST", `/channels/${two}/redis-user`, { headers: mate.cookie }),
        )
      ).statusCode,
    ).toBe(429);
    h.clock.tick(REDIS_ISSUE_COOLDOWN_SEC + 1);
    expect(
      (
        await h.app(
          ev("POST", `/channels/${two}/redis-user`, { headers: mate.cookie }),
        )
      ).statusCode,
    ).toBe(200);
  });

  it("tells the owner when a credential could not be persisted", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await qChannel(h, a);
    h.redisAcl.failNext("issue", "after-mutation");
    const r = await h.app(
      ev("POST", `/channels/${id}/redis-user`, { headers: a.cookie }),
    );
    const body = parse(r);
    // The old password is already gone (`reset` leads the rule string), so
    // withholding the new one would leave the owner with nothing at all.
    expect(r.statusCode).toBe(200);
    expect(body.password).toMatch(/^[0-9a-f]{64}$/);
    expect(body.persisted).toBe(false);
    expect(
      h.db.audits.find((x) => x.action === "channel.redis.issue")?.detail,
    ).toMatchObject({ persisted: false });
  });

  it("keeps the password out of the audit log", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await qChannel(h, a);
    const issued = parse(
      await h.app(
        ev("POST", `/channels/${id}/redis-user`, { headers: a.cookie }),
      ),
    );
    const entries = h.db.audits.filter(
      (x) => x.action === "channel.redis.issue",
    );
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain(issued.password);
  });

  it("revokes on request and on channel delete", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await qChannel(h, a);
    await h.app(
      ev("POST", `/channels/${id}/redis-user`, { headers: a.cookie }),
    );

    const r = parse(
      await h.app(
        ev("DELETE", `/channels/${id}/redis-user`, { headers: a.cookie }),
      ),
    );
    expect(r.revoked).toBe(true);
    expect(h.redisAcl.users.size).toBe(0);
    // Revoking twice is not an error; the second call just found nothing.
    expect(
      parse(
        await h.app(
          ev("DELETE", `/channels/${id}/redis-user`, { headers: a.cookie }),
        ),
      ).revoked,
    ).toBe(false);

    // Past the cooldown, or the re-issue below is a 429 and the final
    // assertion passes without ever having a credential to delete.
    h.clock.tick(REDIS_ISSUE_COOLDOWN_SEC + 1);
    expect(
      (
        await h.app(
          ev("POST", `/channels/${id}/redis-user`, { headers: a.cookie }),
        )
      ).statusCode,
    ).toBe(200);
    expect(h.redisAcl.users.size).toBe(1);
    await h.app(ev("DELETE", `/channels/${id}`, { headers: a.cookie }));
    expect(h.redisAcl.users.size).toBe(0);
  });

  it("survives a revoke failure while deleting a channel", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await qChannel(h, a);
    await h.app(
      ev("POST", `/channels/${id}/redis-user`, { headers: a.cookie }),
    );
    h.redisAcl.failNext("revoke");
    // A Redis hiccup must not block a delete the owner already asked for; the
    // credential it leaves behind is scoped to a channel that no longer exists.
    const r = await h.app(
      ev("DELETE", `/channels/${id}`, { headers: a.cookie }),
    );
    expect(r.statusCode).toBe(204);
    expect(h.db.channels.get(id)!.deletedAt).not.toBeNull();
  });

  it("keeps the credential while the channel is only expired", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await qChannel(h, a);
    await h.app(
      ev("POST", `/channels/${id}/redis-user`, { headers: a.cookie }),
    );

    h.clock.tick(8 * 86400);
    await runExpire({ db: h.db, clock: h.clock, logger: nullLogger });
    // Disabled is not deleted: extending revives the channel, and stripping a
    // credential the owner still holds would be a silent trap.
    expect(h.redisAcl.users.size).toBe(1);

    h.clock.tick(CHANNEL_DELETE_GRACE_SEC + 86400);
    const { deleted } = await runExpire({
      db: h.db,
      clock: h.clock,
      logger: nullLogger,
    });
    expect(deleted.map((d) => d.id)).toContain(id);
    for (const gone of deleted)
      await revokeChannelRedis(h.redisAcl, gone.id, STAGE, nullLogger);
    expect(h.redisAcl.users.size).toBe(0);
  });

  it("reconciles orphans the delete-time revoke dropped", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await qChannel(h, a);
    await h.app(
      ev("POST", `/channels/${id}/redis-user`, { headers: a.cookie }),
    );

    // The failure that would otherwise orphan the account for ever: the row is
    // hard-deleted, so nothing in the database names it any more.
    h.redisAcl.failNext("revoke");
    await h.app(ev("DELETE", `/channels/${id}`, { headers: a.cookie }));
    expect(h.redisAcl.users.size).toBe(1);

    const r = await runRedisAclReconcile({
      admin: h.redisAcl,
      db: h.db,
      stage: STAGE,
      logger: nullLogger,
    });
    expect(r.revoked).toEqual([id]);
    expect(h.redisAcl.users.size).toBe(0);
  });

  it("reconciles an account whose channel row never existed at all", async () => {
    const h = harness();
    h.redisAcl.extraUsers.add(`game_${STAGE}_q_deadbeefdeadbeef`);
    const r = await runRedisAclReconcile({
      admin: h.redisAcl,
      db: h.db,
      stage: STAGE,
      logger: nullLogger,
    });
    expect(r.revoked).toEqual(["q_deadbeefdeadbeef"]);
  });

  it("never touches an account it did not mint", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await qChannel(h, a);
    await h.app(
      ev("POST", `/channels/${id}/redis-user`, { headers: a.cookie }),
    );
    // The platform's own service users share this list, and `DELUSER` is final.
    h.redisAcl.extraUsers.add("svc_platform_account");
    h.redisAcl.extraUsers.add("default");
    // Another stage's account for the same channel: same Redis, not ours.
    h.redisAcl.extraUsers.add(`game_prod_${id}`);

    const r = await runRedisAclReconcile({
      admin: h.redisAcl,
      db: h.db,
      stage: STAGE,
      logger: nullLogger,
    });
    expect(r.revoked).toEqual([]);
    expect(r.checked).toBe(1);
    expect([...h.redisAcl.extraUsers]).toEqual([
      "svc_platform_account",
      "default",
      `game_prod_${id}`,
    ]);
  });

  it("reports who is holding keys, without ever reading one", async () => {
    const h = harness();
    for (let i = 0; i < 7; i++)
      h.redisAcl.keys.add(`game:${STAGE}:q_busy:k${i}`);
    h.redisAcl.keys.add(`game:${STAGE}:q_quiet:k0`);
    // Another stage and another service share the instance and must not be
    // counted into this stage's report.
    h.redisAcl.keys.add(`game:prod:q_busy:k0`);
    h.redisAcl.keys.add(`console:${STAGE}:sess:abc`);
    h.redisAcl.memory = { usedBytes: 10, maxBytes: 100, evictedKeys: 3 };

    const r = await runRedisUsageReport({
      admin: h.redisAcl,
      stage: STAGE,
      logger: nullLogger,
    });
    expect(r.gameKeys).toBe(8);
    expect(r.channels).toBe(2);
    expect(r.top[0]).toEqual({ channelId: "q_busy", keys: 7 });
    expect(r.usedBytes).toBe(10);
    expect(r.maxBytes).toBe(100);
    expect(r.evictedKeys).toBe(3);
  });

  it("usage report is a no-op when the stage has no issuer", async () => {
    await expect(
      runRedisUsageReport({
        admin: undefined,
        stage: STAGE,
        logger: nullLogger,
      }),
    ).resolves.toMatchObject({ gameKeys: 0, channels: 0 });
  });

  it("reconcile is a no-op when the stage has no issuer", async () => {
    const h = harness({ redisAcl: undefined });
    await expect(
      runRedisAclReconcile({
        admin: undefined,
        db: h.db,
        stage: STAGE,
        logger: nullLogger,
      }),
    ).resolves.toEqual({ checked: 0, revoked: [] });
  });

  it("refuses an expired channel", async () => {
    const h = harness();
    const a = await h.team("alice");
    const id = await qChannel(h, a);
    // Expire the channel without ticking past the 7-day session TTL, which
    // would answer 401 and prove nothing about this route.
    h.db.channels.set(id, {
      ...h.db.channels.get(id)!,
      disabledAt: NOW_SEC - 1,
    });
    const r = await h.app(
      ev("POST", `/channels/${id}/redis-user`, { headers: a.cookie }),
    );
    expect(r.statusCode).toBe(409);
    expect(h.redisAcl.users.size).toBe(0);
  });

  it("is 404 for another team, 403 for an admin writing, 404 for non-q kinds", async () => {
    const h = harness();
    const a = await h.team("alice");
    const b = await h.team("bob");
    const boss = await h.login("Boss", "admin");
    const id = await qChannel(h, a);

    expect(
      (
        await h.app(
          ev("POST", `/channels/${id}/redis-user`, { headers: b.cookie }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await h.app(
          ev("POST", `/channels/${id}/redis-user`, { headers: boss.cookie }),
        )
      ).statusCode,
    ).toBe(403);
    // Admins may look — the response holds no secret — but never mint.
    expect(
      (
        await h.app(
          ev("GET", `/channels/${id}/redis-user`, { headers: boss.cookie }),
        )
      ).statusCode,
    ).toBe(200);

    const authId = parse(
      await h.app(
        ev("POST", `/projects/${a.prjId}/channels`, {
          headers: a.cookie,
          body: { kind: "auth", name: "x", config: { audience: "y" } },
        }),
      ),
    ).id as string;
    // 404, not 400: this must not become a way to probe other kinds' ids.
    expect(
      (
        await h.app(
          ev("POST", `/channels/${authId}/redis-user`, { headers: a.cookie }),
        )
      ).statusCode,
    ).toBe(404);
  });

  it("still renders the block when the stage has no issuer, instead of erroring", async () => {
    const h = harness({ redisAcl: undefined });
    const a = await h.team("alice");
    const id = await qChannel(h, a);
    const r = await h.app(
      ev("GET", `/channels/${id}/redis-user`, { headers: a.cookie }),
    );
    // This read backs every `q` channel detail page: failing it would paint an
    // error over a healthy channel on any stage without an issuer account.
    expect(r.statusCode).toBe(200);
    const body = parse(r);
    expect(body.configured).toBe(false);
    // Unknowable rather than guessed.
    expect(body.issued).toBeUndefined();
    expect(body.queueKeyPrefix).toBe(`game:${STAGE}:${id}:queue:`);
  });

  it("answers 503 with a distinguishable reason when the stage has no issuer", async () => {
    const h = harness({ redisAcl: undefined });
    const a = await h.team("alice");
    const id = await qChannel(h, a);
    const r = await h.app(
      ev("POST", `/channels/${id}/redis-user`, { headers: a.cookie }),
    );
    expect(r.statusCode).toBe(503);
    expect(parse(r).error.details).toEqual({
      reason: "redis_acl_not_configured",
    });
  });
});
