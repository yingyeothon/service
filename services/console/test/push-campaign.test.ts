/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { describe, expect, it } from "vitest";
import type { Logger } from "@yyt/core";
import {
  PUSH_TEMPLATES_PER_CHANNEL,
  PUSH_UPLOADS_PER_CHANNEL,
  pushDay,
  pushTokenHash,
} from "@yyt/console-db";
import { createFakePushPool, pushChannelTopic } from "@yyt/push";
import type { HttpEvent, HttpResult } from "@yyt/http";
import { LIMITS } from "../src/limits.js";
import {
  PUSH_CSV_MAX_BYTES,
  PUSH_DRY_RUNS_PER_DAY,
  PUSH_REPORT_TTL_SEC,
  PUSH_UPLOAD_USABLE_SEC,
} from "../src/push-campaign.js";
import {
  pushReportKey,
  pushReportPartKey,
  pushReportPartsPrefix,
  pushUploadKey,
} from "../src/push-job-store.js";
import {
  drainPushCampaign,
  PUSH_JOB_MAX_AGE_SEC,
  PUSH_JOB_RETAIN_SEC,
  PUSH_JOB_STALE_SEC,
  PUSH_UPLOAD_RETAIN_SEC,
  runPushJobSweep,
} from "../src/push-job-sweep.js";
import {
  PUSH_JOB_MAX_ATTEMPTS,
  PUSH_JOB_MAX_WAITS,
  PUSH_JOB_QUOTA_PAUSE_MS,
  PUSH_JOB_RETRY_DELAY_SEC,
  runPushJobs,
  type PushWorkerDeps,
} from "../src/push-worker.js";
import { runUsageDigest } from "../src/usage-digest.js";
import { ev, harness, NOW_SEC, parse, type Team } from "./helpers.js";

type H = ReturnType<typeof harness>;

/** The fake pool's first project; never part of a team-facing answer. */
const P1 = "example-project-1";
const TEAM_PROJECT = "example-team-project";
const PKG = "com.example.game";
const DAY = pushDay(NOW_SEC);

/** Every line the app and the worker logged, as one searchable string. */
function recorder() {
  const lines: string[] = [];
  const at =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      lines.push(`${level} ${message} ${JSON.stringify(meta ?? {})}`);
    };
  const logger: Logger = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
  return { logger, lines, text: () => lines.join("\n") };
}

/** Recorded writes share one 500 ms slot per caller; step past it. */
const send = (h: H, e: HttpEvent) => {
  h.clock.tick(1);
  return h.app(e);
};

const user = (n: number) => n.toString(16).padStart(32, "0");
const tokenOf = (n: number, device = 0) => `fcm-token-${n}-${device}:APA91b-zz`;
const errorOf = (r: HttpResult) => parse(r).error;

interface Ctx {
  h: H;
  a: Team;
  /** The push channel's id and apiKey. */
  id: string;
  key: string;
  auth: string;
  log: ReturnType<typeof recorder>;
}

async function setup(
  over: Parameters<typeof harness>[0] = {},
  config: Record<string, unknown> = {},
): Promise<Ctx> {
  const log = recorder();
  const h = harness({ logger: log.logger, ...over });
  const a = await h.team("alice");
  const authR = await send(
    h,
    ev("POST", `/projects/${a.prjId}/channels`, {
      headers: a.cookie,
      body: { kind: "auth", name: "base", config: { audience: "x" } },
    }),
  );
  expect(authR.statusCode, authR.body).toBe(201);
  const auth = parse(authR).id as string;
  const c = await send(
    h,
    ev("POST", `/projects/${a.prjId}/channels`, {
      headers: a.cookie,
      body: {
        kind: "push",
        name: "push",
        config: { authChannelId: auth, packageName: PKG, ...config },
      },
    }),
  );
  expect(c.statusCode, c.body).toBe(201);
  const ch = parse(c);
  return { h, a, id: ch.id, key: ch.apiKey, auth, log };
}

/** A device token of `user(n)` in the channel, on the platform project. */
const putToken = (c: Ctx, n: number, device = 0, project = P1) =>
  c.h.push.putToken({
    channelId: c.id,
    userId: user(n),
    token: tokenOf(n, device),
    firebaseProject: project,
    platform: "android",
    at: NOW_SEC,
  });

const member = (c: Ctx, method: string, path: string, body?: unknown) =>
  send(
    c.h,
    ev(method, `/channels/${c.id}/push${path}`, {
      headers: c.a.cookie,
      ...(body === undefined ? {} : { body }),
    }),
  );

const api = (
  c: Ctx,
  method: string,
  path: string,
  body?: unknown,
  key: string | null = c.key,
) =>
  send(
    c.h,
    ev(method, `/push-api/${c.id}${path}`, {
      headers: key === null ? {} : { authorization: `Bearer ${key}` },
      ...(body === undefined ? {} : { body }),
    }),
  );

async function makeTemplate(
  c: Ctx,
  body: Record<string, unknown> = { title: "Hi {{name}}", body: "Welcome" },
  name = "welcome",
): Promise<string> {
  const r = await member(c, "POST", "/templates", { name, ...body });
  expect(r.statusCode, r.body).toBe(201);
  return parse(r).id as string;
}

/** Issues an upload URL and "PUTs" the CSV to it. */
async function upload(c: Ctx, csv: string | Buffer): Promise<string> {
  const size = Buffer.byteLength(csv);
  const r = await member(c, "POST", "/uploads", { size });
  expect(r.statusCode, r.body).toBe(201);
  const uploadId = parse(r).uploadId as string;
  c.h.pushStore.upload(pushUploadKey(c.id, uploadId), csv);
  return uploadId;
}

let keySeq = 0;
async function submit(
  c: Ctx,
  csv: string,
  o: {
    template?: Record<string, unknown>;
    dryRun?: boolean;
    key?: string;
    extra?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const templateId = await makeTemplate(c, o.template, `t${++keySeq}`);
  const uploadId = await upload(c, csv);
  const r = await member(c, "POST", "/jobs", {
    templateId,
    uploadId,
    idempotencyKey: o.key ?? `key-${++keySeq}`,
    ...(o.dryRun === undefined ? {} : { dryRun: o.dryRun }),
    ...o.extra,
  });
  expect(r.statusCode, r.body).toBe(202);
  return parse(r).job.id as string;
}

const worker = (c: Ctx, over: Partial<PushWorkerDeps> = {}) =>
  runPushJobs({
    jobs: c.h.pushJobs,
    push: c.h.push,
    channels: c.h.db,
    limits: c.h.limits,
    pool: c.h.fcm.pool,
    store: c.h.pushStore.store,
    clock: c.h.clock,
    logger: c.log.logger,
    sleep: async () => undefined,
    ...over,
  });

const jobOf = async (c: Ctx, jobId: string) => {
  const r = await member(c, "GET", `/jobs/${jobId}`);
  expect(r.statusCode, r.body).toBe(200);
  return parse(r).job;
};
const reportOf = (c: Ctx, jobId: string) =>
  c.h.pushStore.text(pushReportKey(c.id, jobId));
const audits = (h: H, action: string) =>
  h.db.audits.filter((a) => a.action === action);

/** `userId,name` rows for users `from..to-1`. */
const csvOf = (from: number, to: number) =>
  "userId,name\n" +
  Array.from({ length: to - from }, (_, i) => `${user(from + i)},n${from + i}`)
    .map((l) => `${l}\n`)
    .join("");

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

describe("push templates", () => {
  it("creates, lists, reads, patches and deletes, each audited", async () => {
    const c = await setup();
    const created = await member(c, "POST", "/templates", {
      name: "welcome",
      title: "Hi {{name}}",
      body: "You have {{count}} gifts",
      data: { link: "app://gift/{{giftId}}", kind: "gift" },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.headers?.["cache-control"]).toBe("no-store");
    const t = parse(created);
    expect(t).toMatchObject({
      channelId: c.id,
      name: "welcome",
      title: "Hi {{name}}",
      body: "You have {{count}} gifts",
      data: { link: "app://gift/{{giftId}}", kind: "gift" },
      variables: ["count", "giftId", "name"],
      createdBy: c.a.id,
      createdByLogin: "alice",
      updatedBy: c.a.id,
    });
    expect(t.id).toMatch(/^pt_[0-9a-z]{26}$/);

    const list = parse(await member(c, "GET", "/templates"));
    expect(list.max).toBe(PUSH_TEMPLATES_PER_CHANNEL);
    expect(list.templates.map((x: { id: string }) => x.id)).toEqual([t.id]);
    expect(parse(await member(c, "GET", `/templates/${t.id}`))).toMatchObject({
      id: t.id,
      variables: ["count", "giftId", "name"],
    });

    // A patch changes what it names and checks the message as a whole.
    const patched = await member(c, "PATCH", `/templates/${t.id}`, {
      name: "welcome-2",
      body: "",
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(parse(patched)).toMatchObject({
      name: "welcome-2",
      title: "Hi {{name}}",
      body: "",
      variables: ["giftId", "name"],
    });
    const whole = await member(c, "PATCH", `/templates/${t.id}`, {
      title: "",
      data: {},
    });
    expect(whole.statusCode).toBe(400);

    const gone = await member(c, "DELETE", `/templates/${t.id}`);
    expect(gone.statusCode).toBe(204);
    expect((await member(c, "GET", `/templates/${t.id}`)).statusCode).toBe(404);
    expect((await member(c, "DELETE", `/templates/${t.id}`)).statusCode).toBe(
      404,
    );
    expect(
      (await member(c, "PATCH", `/templates/${t.id}`, { title: "x" }))
        .statusCode,
    ).toBe(404);
    expect(audits(c.h, "push.template.create")).toHaveLength(1);
    expect(audits(c.h, "push.template.update")).toHaveLength(1);
    expect(audits(c.h, "push.template.delete")).toHaveLength(1);
  });

  it("refuses bad templates, a taken name and the 21st", async () => {
    const c = await setup();
    const post = (body: unknown) => member(c, "POST", "/templates", body);
    for (const bad of [
      { name: "has blank", title: "T" },
      { name: "ok" },
      { name: "ok", body: "no title" },
      { name: "ok", title: "T", data: { from: "x" } },
      { name: "ok", title: "T", data: { a: 1 } },
      { name: "ok", title: "T", extra: 1 },
      { title: "T" },
    ])
      expect((await post(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    const big = await post({
      name: "big",
      title: "T",
      data: { a: "x".repeat(1000), b: "x".repeat(4000) },
    });
    expect(big.statusCode).toBe(400);
    expect(errorOf(big).details).toEqual({ reason: "push_payload_too_large" });

    await makeTemplate(c, { title: "T" }, "Promo");
    const dup = await post({ name: "promo", title: "T" });
    expect(dup.statusCode).toBe(409);
    expect(errorOf(dup).details).toEqual({
      reason: "push_template_name_taken",
    });
    const other = await makeTemplate(c, { title: "T" }, "other");
    const rename = await member(c, "PATCH", `/templates/${other}`, {
      name: "PROMO",
    });
    expect(rename.statusCode).toBe(409);

    for (let i = 2; i < PUSH_TEMPLATES_PER_CHANNEL; i++)
      await makeTemplate(c, { title: "T" }, `t${i}`);
    const over = await post({ name: "one-too-many", title: "T" });
    expect(over.statusCode).toBe(409);
    expect(errorOf(over).details).toEqual({
      reason: "push_template_cap",
      max: PUSH_TEMPLATES_PER_CHANNEL,
    });
  });

  it("is for the channel's project members, and for push channels only", async () => {
    const c = await setup();
    const t = await makeTemplate(c);
    const bob = await c.h.team("bob");
    const asBob = (method: string, path: string, body?: unknown) =>
      send(
        c.h,
        ev(method, `/channels/${c.id}/push${path}`, {
          headers: bob.cookie,
          ...(body === undefined ? {} : { body }),
        }),
      );
    expect((await asBob("GET", "/templates")).statusCode).toBe(404);
    expect((await asBob("GET", `/templates/${t}`)).statusCode).toBe(404);
    expect(
      (await asBob("POST", "/templates", { name: "x", title: "T" })).statusCode,
    ).toBe(404);
    expect((await asBob("DELETE", `/templates/${t}`)).statusCode).toBe(404);
    expect((await asBob("GET", "/jobs")).statusCode).toBe(404);
    // No session at all.
    expect(
      (await send(c.h, ev("GET", `/channels/${c.id}/push/templates`)))
        .statusCode,
    ).toBe(401);
    // The apiKey is no member credential, and its family serves no template.
    expect(
      (
        await send(
          c.h,
          ev("GET", `/channels/${c.id}/push/templates`, {
            headers: { authorization: `Bearer ${c.key}` },
          }),
        )
      ).statusCode,
    ).toBe(401);
    expect((await api(c, "GET", "/templates")).statusCode).toBe(404);
    expect(
      (await api(c, "POST", "/templates", { name: "x", title: "T" }))
        .statusCode,
    ).toBe(404);
    // An auth channel has no push routes.
    const onAuth = await send(
      c.h,
      ev("GET", `/channels/${c.auth}/push/templates`, {
        headers: c.a.cookie,
      }),
    );
    expect(onAuth.statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* Uploads and submit                                                  */
/* ------------------------------------------------------------------ */

describe("push campaign uploads", () => {
  it("issues a presigned PUT for exactly the declared bytes of text/csv", async () => {
    const c = await setup();
    const r = await member(c, "POST", "/uploads", { size: 1234 });
    expect(r.statusCode, r.body).toBe(201);
    const u = parse(r);
    expect(u).toMatchObject({
      method: "PUT",
      headers: { "content-type": "text/csv", "content-length": "1234" },
      maxBytes: PUSH_CSV_MAX_BYTES,
      usableUntil: u.expiresAt - 900 + PUSH_UPLOAD_USABLE_SEC,
    });
    expect(u.uploadId).toMatch(/^pu_[0-9a-z]{26}$/);
    expect(u.url).toContain(`push-uploads/${c.id}/${u.uploadId}.csv`);
    expect(await c.h.pushJobs.findUpload(c.id, u.uploadId)).toMatchObject({
      size: 1234,
      createdBy: c.a.id,
    });
    // The hard limit of rows at the longest row, plus a header.
    expect(PUSH_CSV_MAX_BYTES).toBe(
      (LIMITS["push.recipientsPerJob"].hard + 1) * 1024,
    );
    for (const size of [0, -1, 1.5, PUSH_CSV_MAX_BYTES + 1, "10"])
      expect((await member(c, "POST", "/uploads", { size })).statusCode).toBe(
        400,
      );
    expect(
      (await member(c, "POST", "/uploads", { size: PUSH_CSV_MAX_BYTES }))
        .statusCode,
    ).toBe(201);
  });

  it(`refuses the ${PUSH_UPLOADS_PER_CHANNEL + 1}st pending upload and a stage without a bucket`, async () => {
    const c = await setup();
    for (let i = 0; i < PUSH_UPLOADS_PER_CHANNEL; i++)
      expect(
        (await member(c, "POST", "/uploads", { size: 10 })).statusCode,
      ).toBe(201);
    const over = await member(c, "POST", "/uploads", { size: 10 });
    expect(over.statusCode).toBe(409);
    expect(errorOf(over).details).toEqual({
      reason: "push_upload_cap",
      max: PUSH_UPLOADS_PER_CHANNEL,
    });

    const bare = await setup({ pushJobStore: undefined });
    const r = await member(bare, "POST", "/uploads", { size: 10 });
    expect(r.statusCode).toBe(503);

    // A URL that could not be signed leaves no row behind.
    const d = await setup();
    d.h.pushStore.failNext.op = "presignUploadPut";
    expect((await member(d, "POST", "/uploads", { size: 10 })).statusCode).toBe(
      503,
    );
    expect(d.h.pushJobs.uploads.size).toBe(0);
  });
});

describe("push campaign submit", () => {
  it("records a queued job with the template's text, kicks the worker and audits", async () => {
    const c = await setup();
    const templateId = await makeTemplate(c, {
      title: "Hi {{name}}",
      data: { k: "v" },
    });
    const uploadId = await upload(c, csvOf(0, 3));
    const kicks = c.h.pushKicks.length;
    const r = await member(c, "POST", "/jobs", {
      templateId,
      uploadId,
      idempotencyKey: "launch-1",
      priority: "high",
      ttlSec: 600,
      collapseKey: "promo",
    });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.headers?.["cache-control"]).toBe("no-store");
    const { job, created } = parse(r);
    expect(created).toBe(true);
    expect(job).toMatchObject({
      channelId: c.id,
      kind: "campaign",
      dryRun: false,
      status: "queued",
      error: null,
      errorDetails: null,
      cancelRequested: false,
      idempotencyKey: "launch-1",
      templateId,
      uploadId,
      message: { title: "Hi {{name}}", body: "", data: { k: "v" } },
      options: { priority: "high", ttlSec: 600, collapseKey: "promo" },
      author: c.a.id,
      total: null,
      processed: 0,
      counts: {
        resolved: 0,
        sent: 0,
        noToken: 0,
        unregistered: 0,
        failed: 0,
        skipped: 0,
        duplicates: 0,
        missingVariables: 0,
        invalid: 0,
      },
      report: null,
      startedAt: null,
      finishedAt: null,
    });
    expect(job.id).toMatch(/^pj_[0-9a-z]{26}$/);
    expect(c.h.pushKicks.length).toBe(kicks + 1);
    expect(audits(c.h, "push.job.submit")).toMatchObject([
      {
        actorId: c.a.id,
        target: job.id,
        detail: { channelId: c.id, kind: "campaign", dryRun: false },
      },
    ]);

    // A later template edit does not reach the job.
    await member(c, "PATCH", `/templates/${templateId}`, { title: "Changed" });
    expect((await jobOf(c, job.id)).message.title).toBe("Hi {{name}}");
    const list = parse(await member(c, "GET", "/jobs"));
    expect(list.jobs.map((j: { id: string }) => j.id)).toEqual([job.id]);
    expect(list.next).toBeNull();
  });

  it("answers a repeated idempotencyKey with the same job, and 409 when the parameters differ", async () => {
    const c = await setup();
    const templateId = await makeTemplate(c);
    const uploadId = await upload(c, csvOf(0, 2));
    const body = { templateId, uploadId, idempotencyKey: "once" };
    const first = await member(c, "POST", "/jobs", body);
    expect(first.statusCode).toBe(202);
    const kicks = c.h.pushKicks.length;
    const again = await member(c, "POST", "/jobs", body);
    expect(again.statusCode).toBe(200);
    expect(parse(again)).toMatchObject({
      created: false,
      job: { id: parse(first).job.id },
    });
    // The replay records nothing, kicks nothing.
    expect(c.h.pushKicks.length).toBe(kicks);
    expect(audits(c.h, "push.job.submit")).toHaveLength(1);
    expect(c.h.pushJobs.jobs.size).toBe(1);

    for (const other of [
      { ...body, dryRun: true },
      { ...body, priority: "high" },
      { ...body, uploadId: await upload(c, csvOf(0, 2)) },
      { ...body, templateId: await makeTemplate(c, { title: "x" }, "x") },
    ]) {
      const r = await member(c, "POST", "/jobs", other);
      expect(r.statusCode, r.body).toBe(409);
      expect(errorOf(r).details).toEqual({ reason: "idempotency_key_reused" });
    }
    // A replay still answers once the template and the upload are gone.
    await member(c, "DELETE", `/templates/${templateId}`);
    await c.h.pushJobs.deleteUploads([uploadId]);
    expect((await member(c, "POST", "/jobs", body)).statusCode).toBe(200);
    // The same key through the apiKey names the same job.
    const viaKey = await api(c, "POST", "/jobs", body);
    expect(viaKey.statusCode).toBe(200);
    expect(parse(viaKey).job.id).toBe(parse(first).job.id);
  });

  it("refuses a job whose template, upload or CSV header cannot be used", async () => {
    const c = await setup();
    const templateId = await makeTemplate(c, { title: "Hi {{name}} {{tier}}" });
    const good = await upload(c, "userId,name,tier\n");
    let n = 0;
    const post = (o: Record<string, unknown>) =>
      member(c, "POST", "/jobs", {
        templateId,
        uploadId: good,
        idempotencyKey: `k${++n}`,
        ...o,
      });
    for (const bad of [
      { idempotencyKey: "has blank" },
      { idempotencyKey: "" },
      { templateId: "x y" },
      { dryRun: "yes" },
      { ttlSec: -1 },
      { priority: "urgent" },
      { collapseKey: "a b" },
      { unknown: 1 },
    ])
      expect((await post(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    expect((await post({ templateId: "pt_none" })).statusCode).toBe(404);
    expect((await post({ uploadId: "pu_none" })).statusCode).toBe(404);

    // A URL was issued but nothing was put there.
    const empty = parse(await member(c, "POST", "/uploads", { size: 5 }));
    const missing = await post({ uploadId: empty.uploadId });
    expect(missing.statusCode).toBe(409);
    expect(errorOf(missing).details).toEqual({ reason: "upload_missing" });
    // Another length than the signed one.
    c.h.pushStore.upload(pushUploadKey(c.id, empty.uploadId), "userId\nabc\n");
    const size = await post({ uploadId: empty.uploadId });
    expect(size.statusCode).toBe(409);
    expect(errorOf(size).details).toEqual({ reason: "upload_size_mismatch" });

    const csv = async (text: string | Buffer) =>
      errorOf(await post({ uploadId: await upload(c, text) }));
    expect(await csv("name,tier\nx,y\n")).toMatchObject({
      code: "bad_request",
      details: { reason: "csv_invalid", csv: "user_column_missing", line: 1 },
    });
    expect((await csv("userId,name,tier,deviceToken\n")).details).toEqual({
      reason: "csv_invalid",
      csv: "token_column",
      line: 1,
    });
    expect((await csv("userId,na me\n")).details).toMatchObject({
      csv: "header_name",
    });
    expect((await csv("userId,name,name\n")).details).toMatchObject({
      csv: "duplicate_header",
    });
    expect((await csv("\n\n")).details).toMatchObject({ csv: "empty" });
    expect((await csv('"userId\n')).details).toMatchObject({
      csv: "unterminated_quote",
    });
    expect((await csv(Buffer.from([0xff, 0xfe, 0x0a]))).details).toMatchObject({
      csv: "invalid_utf8",
    });
    // A column the template names is absent; the names are the template's.
    expect(await csv("userId,name\nu,n\n")).toMatchObject({
      code: "bad_request",
      details: { reason: "csv_missing_columns", columns: ["tier"] },
    });
    // A byte-order mark and a header without a line break are fine.
    expect(
      (
        await post({
          uploadId: await upload(
            c,
            Buffer.concat([
              Buffer.from([0xef, 0xbb, 0xbf]),
              Buffer.from("tier,userId,name"),
            ]),
          ),
        })
      ).statusCode,
    ).toBe(202);
    // An error in a later row is the worker's to report.
    expect(
      (await post({ uploadId: await upload(c, 'userId,name,tier\n"x\n') }))
        .statusCode,
    ).toBe(202);

    // An upload older than a day is refused.
    const old = await upload(c, "userId,name,tier\n");
    c.h.clock.tick(PUSH_UPLOAD_USABLE_SEC);
    const stale = await post({ uploadId: old });
    expect(stale.statusCode).toBe(409);
    expect(errorOf(stale).details).toEqual({ reason: "upload_expired" });
  });

  it("answers 503 when the pool is unprovisioned, and 409 for an unregistered channel; a dry run needs neither", async () => {
    const empty = createFakePushPool({ slots: 0 });
    const c = await setup();
    const templateId = await makeTemplate(c);
    const uploadId = await upload(c, csvOf(0, 1));
    // The same channel on an app whose pool went away.
    const h2 = harness({
      db: c.h.db,
      pushJobs: c.h.pushJobs,
      pushJobStore: c.h.pushStore.store,
      limits: c.h.limits,
      team: c.h.teamDb,
      kv: c.h.kv,
      pushPool: empty.pool,
      clock: c.h.clock,
    });
    const post = (app: H, body: Record<string, unknown>) => {
      c.h.clock.tick(1);
      return app.app(
        ev("POST", `/push-api/${c.id}/jobs`, {
          headers: { authorization: `Bearer ${c.key}` },
          body: { templateId, uploadId, ...body },
        }),
      );
    };
    const r = await post(h2, { idempotencyKey: "a" });
    expect(r.statusCode).toBe(503);
    expect(errorOf(r).details).toEqual({ reason: "push_not_configured" });
    c.h.clock.tick(1);
    const b = await h2.app(
      ev("POST", `/push-api/${c.id}/broadcast`, {
        headers: { authorization: `Bearer ${c.key}` },
        body: { title: "T", idempotencyKey: "b" },
      }),
    );
    expect(b.statusCode).toBe(503);
    expect(c.h.pushJobs.jobs.size).toBe(0);
    expect(
      (await post(h2, { idempotencyKey: "c", dryRun: true })).statusCode,
    ).toBe(202);
    // No pool at all on the function.
    const h3 = harness({
      db: c.h.db,
      pushJobs: c.h.pushJobs,
      pushJobStore: c.h.pushStore.store,
      limits: c.h.limits,
      team: c.h.teamDb,
      kv: c.h.kv,
      pushPool: undefined,
      clock: c.h.clock,
    });
    expect((await post(h3, { idempotencyKey: "d" })).statusCode).toBe(503);
    // The channel's slot is not in the pool any more.
    const moved = createFakePushPool({ slots: 2 });
    moved.sources.shift();
    moved.pool.refresh();
    const h4 = harness({
      db: c.h.db,
      pushJobs: c.h.pushJobs,
      pushJobStore: c.h.pushStore.store,
      limits: c.h.limits,
      team: c.h.teamDb,
      kv: c.h.kv,
      pushPool: moved.pool,
      clock: c.h.clock,
    });
    const gone = await post(h4, { idempotencyKey: "e" });
    expect(gone.statusCode).toBe(503);
    expect(errorOf(gone).message).toBe("push sender unavailable");

    // A registration that never finished: neither a slot nor a team key.
    await c.h.db.editChannel(c.id, (cur) => {
      const config = JSON.parse(cur.configJson);
      delete config.slot;
      delete config.firebaseAppId;
      return { config, secret: JSON.parse(cur.secretJson) };
    });
    const unreg = await post(c.h, { idempotencyKey: "f" });
    expect(unreg.statusCode).toBe(409);
    expect(errorOf(unreg).details).toEqual({ reason: "push_not_registered" });
  });

  it("holds push.jobsPerDay inside the submit, with the limit's shape, and counts dry runs apart", async () => {
    const c = await setup();
    const soft = LIMITS["push.jobsPerDay"].soft;
    expect(soft).toBe(10);
    expect(LIMITS["push.jobsPerDay"].hard).toBe(100);
    expect(LIMITS["push.recipientsPerJob"]).toMatchObject({
      scope: "channel",
      channelKind: "push",
      soft: 10_000,
      hard: 100_000,
    });
    const templateId = await makeTemplate(c);
    const uploadId = await upload(c, csvOf(0, 1));
    const post = (key: string, o: Record<string, unknown> = {}) =>
      member(c, "POST", "/jobs", {
        templateId,
        uploadId,
        idempotencyKey: key,
        ...o,
      });
    for (let i = 0; i < soft - 1; i++)
      expect((await post(`k${i}`)).statusCode).toBe(202);
    // A broadcast is one job of the same count.
    const b = await member(c, "POST", "/broadcast", {
      title: "T",
      idempotencyKey: "b1",
    });
    expect(b.statusCode, b.body).toBe(202);
    const over = await post("over");
    expect(over.statusCode).toBe(409);
    expect(errorOf(over)).toMatchObject({
      code: "conflict",
      details: { limit: "push.jobsPerDay", value: soft },
    });
    const overB = await member(c, "POST", "/broadcast", {
      title: "T",
      idempotencyKey: "b2",
    });
    expect(overB.statusCode).toBe(409);
    expect(errorOf(overB).details).toEqual({
      limit: "push.jobsPerDay",
      value: soft,
    });
    // A replay is still answered, and a dry run is not counted.
    expect((await post("k0")).statusCode).toBe(200);
    expect((await post("dry", { dryRun: true })).statusCode).toBe(202);

    // The limits view names both keys for a push channel, with today's usage.
    const view = parse(
      await send(
        c.h,
        ev("GET", "/limits", {
          headers: c.a.cookie,
          query: { scope: `channel:${c.id}` },
        }),
      ),
    );
    const rows = Object.fromEntries(
      view.limits.map((l: { key: string }) => [l.key, l]),
    );
    expect(Object.keys(rows).sort()).toEqual([
      "channel.lifetime",
      "push.jobsPerDay",
      "push.recipientsPerJob",
    ]);
    expect(rows["push.jobsPerDay"]).toMatchObject({
      soft: 10,
      hard: 100,
      effective: 10,
      usage: 10,
      unit: "count",
    });
    expect(rows["push.recipientsPerJob"]).toMatchObject({
      soft: 10_000,
      hard: 100_000,
      effective: 10_000,
      usage: null,
    });
    // Another kind of channel has neither, and cannot ask for one.
    const onAuth = parse(
      await send(
        c.h,
        ev("GET", "/limits", {
          headers: c.a.cookie,
          query: { scope: `channel:${c.auth}` },
        }),
      ),
    );
    expect(onAuth.limits.map((l: { key: string }) => l.key)).toEqual([
      "channel.lifetime",
    ]);
    const ask = await send(
      c.h,
      ev("POST", "/limit-requests", {
        headers: c.a.cookie,
        body: {
          scope: `channel:${c.auth}`,
          key: "push.jobsPerDay",
          value: 20,
          reason: "more",
        },
      }),
    );
    expect(ask.statusCode).toBe(400);

    // An admin's grant lifts the cap; on another channel kind it is refused.
    const boss = await c.h.login("Boss", "admin");
    const grant = (channelId: string, key: string, value: number) =>
      send(
        c.h,
        ev("PUT", `/admin/limit-overrides/channel/${channelId}/${key}`, {
          headers: boss.cookie,
          body: { value, note: "contest" },
        }),
      );
    expect((await grant(c.auth, "push.jobsPerDay", 12)).statusCode).toBe(400);
    expect((await grant(c.id, "push.jobsPerDay", 101)).statusCode).toBe(400);
    const granted = await grant(c.id, "push.jobsPerDay", 12);
    expect(granted.statusCode, granted.body).toBe(200);
    expect((await post("after-grant")).statusCode).toBe(202);

    // The next UTC day starts at zero.
    c.h.clock.tick(86_400);
    const fresh = await upload(c, csvOf(0, 1));
    expect(
      (
        await member(c, "POST", "/jobs", {
          templateId,
          uploadId: fresh,
          idempotencyKey: "tomorrow",
        })
      ).statusCode,
    ).toBe(202);
  });

  it(`bounds dry runs at ${PUSH_DRY_RUNS_PER_DAY} a day with a constant`, async () => {
    const c = await setup();
    const templateId = await makeTemplate(c);
    const uploadId = await upload(c, csvOf(0, 1));
    // Seeded through the repository: the route's write slot is not the point.
    for (let i = 0; i < PUSH_DRY_RUNS_PER_DAY; i++)
      await c.h.pushJobs.submitJob(
        {
          id: `pj_seed${i}`,
          channelId: c.id,
          kind: "campaign",
          dryRun: true,
          idempotencyKey: `seed-${i}`,
          paramsHash: "0".repeat(64),
          templateId,
          title: "T",
          body: "",
          data: {},
          options: {},
          uploadId,
          uploadEtag: '"v1"',
          day: DAY,
          author: c.a.id,
          at: NOW_SEC,
        },
        PUSH_DRY_RUNS_PER_DAY,
      );
    const r = await member(c, "POST", "/jobs", {
      templateId,
      uploadId,
      idempotencyKey: "one-more",
      dryRun: true,
    });
    expect(r.statusCode).toBe(409);
    expect(errorOf(r).details).toEqual({
      reason: "push_dry_run_cap",
      max: PUSH_DRY_RUNS_PER_DAY,
    });
    // Real jobs are untouched by it.
    expect(
      (
        await member(c, "POST", "/jobs", {
          templateId,
          uploadId,
          idempotencyKey: "real",
        })
      ).statusCode,
    ).toBe(202);
  });
});

/* ------------------------------------------------------------------ */
/* The worker                                                          */
/* ------------------------------------------------------------------ */

/**
 * Users 1-3 hold a token, 4 holds none, 5's token is dead; one row lacks its
 * variable, one repeats a user, one is no user id.
 */
const MIXED =
  "userId,name\n" +
  `${user(1)},Ann\n` +
  `${user(2)},"B, ""ob"""\n` +
  `${user(4)},Dee\n` +
  `${user(3)},\n` +
  `${user(1)},Again\n` +
  `=cmd|x,Eve\n` +
  `${user(5)},Fay\n`;

async function seedMixed(c: Ctx) {
  for (const n of [1, 2, 3, 5]) await putToken(c, n);
  c.h.fcm.google.deviceTokens.set(tokenOf(5), "unregistered");
}

describe("push campaign worker", () => {
  it("dry run: resolves, counts and reports every row, and sends nothing", async () => {
    const c = await setup();
    await seedMixed(c);
    const jobId = await submit(c, MIXED, { dryRun: true });
    const run = await worker(c);
    expect(run).toEqual({ claimed: 1, more: false });
    const job = await jobOf(c, jobId);
    expect(job).toMatchObject({
      status: "done",
      dryRun: true,
      error: null,
      total: 7,
      processed: 7,
      counts: {
        resolved: 3,
        sent: 0,
        noToken: 1,
        unregistered: 0,
        failed: 0,
        skipped: 3,
        duplicates: 1,
        missingVariables: 1,
        invalid: 1,
      },
    });
    expect(job.report).toMatchObject({ available: true });
    expect(c.h.fcm.google.sent).toHaveLength(0);
    expect(c.h.fcm.google.calls.send).toBe(0);
    // A dry run adds nothing to the day's send counters and deletes nothing.
    expect(c.h.push.stats.size).toBe(0);
    expect(c.h.push.tokens.size).toBe(4);
    expect(reportOf(c, jobId)).toBe(
      "userId,status,reason\n" +
        `${user(1)},resolved,\n` +
        `${user(2)},resolved,\n` +
        `${user(4)},no-token,\n` +
        `${user(3)},skipped,missing-variable\n` +
        `${user(1)},skipped,duplicate\n` +
        `'=cmd|x,skipped,invalid-user\n` +
        `${user(5)},resolved,\n`,
    );
  });

  it("sends a job to done: one rendered message per token, a per-row report, stats and dead tokens", async () => {
    const c = await setup();
    await seedMixed(c);
    // A second device for user 1.
    await putToken(c, 1, 1);
    const jobId = await submit(c, MIXED, {
      template: {
        title: "Hi {{name}}",
        body: "for {{userId}}",
        data: { who: "{{name}}", kind: "promo" },
      },
      extra: { priority: "high", ttlSec: 60, collapseKey: "promo" },
    });
    expect(await worker(c)).toEqual({ claimed: 1, more: false });
    const job = await jobOf(c, jobId);
    expect(job).toMatchObject({
      status: "done",
      error: null,
      total: 7,
      processed: 7,
      counts: {
        resolved: 3,
        sent: 2,
        noToken: 1,
        unregistered: 1,
        failed: 0,
        skipped: 3,
        duplicates: 1,
        missingVariables: 1,
        invalid: 1,
      },
    });
    expect(job.startedAt).not.toBeNull();
    expect(job.finishedAt).not.toBeNull();
    expect(job.report).toEqual({
      available: true,
      expiresAt: job.finishedAt + PUSH_REPORT_TTL_SEC,
    });

    const sent = c.h.fcm.google.sent;
    expect(sent).toHaveLength(3);
    expect(sent.every((m) => m.projectId === P1)).toBe(true);
    const byToken = new Map(
      sent.map((m) => [(m.target as { token: string }).token, m]),
    );
    expect(byToken.get(tokenOf(1))).toMatchObject({
      notification: { title: "Hi Ann", body: `for ${user(1)}` },
      data: { who: "Ann", kind: "promo" },
      priority: "high",
      ttlSec: 60,
      collapseKey: "promo",
    });
    expect(byToken.get(tokenOf(1, 1))?.notification?.title).toBe("Hi Ann");
    expect(byToken.get(tokenOf(2))?.notification?.title).toBe('Hi B, "ob"');

    expect(reportOf(c, jobId)).toBe(
      "userId,status,reason\n" +
        `${user(1)},sent,\n` +
        `${user(2)},sent,\n` +
        `${user(4)},no-token,\n` +
        `${user(3)},skipped,missing-variable\n` +
        `${user(1)},skipped,duplicate\n` +
        `'=cmd|x,skipped,invalid-user\n` +
        `${user(5)},unregistered,\n`,
    );
    // The parts are joined and gone.
    expect(
      [...c.h.pushStore.objects.keys()].filter((k) => k.includes(".parts/")),
    ).toEqual([]);
    // The dead token is deleted, the day's counters are fed.
    expect(c.h.push.tokens.has(`${pushTokenHash(tokenOf(5))}|${c.id}`)).toBe(
      false,
    );
    expect(c.h.push.tokens.size).toBe(4);
    expect([...c.h.push.stats.values()]).toEqual([
      {
        channelId: c.id,
        day: DAY,
        calls: 1,
        sent: 2,
        noToken: 1,
        failed: 1,
        unregistered: 1,
      },
    ]);
  });

  it("carries no device token and no Firebase project id in any answer, report or log line", async () => {
    const c = await setup();
    await seedMixed(c);
    const jobId = await submit(c, MIXED);
    await worker(c);
    const answers = [
      await member(c, "GET", `/jobs/${jobId}`),
      await member(c, "GET", "/jobs"),
      await member(c, "GET", `/jobs/${jobId}/report`),
      await api(c, "GET", `/jobs/${jobId}`),
      await member(c, "GET", "/templates"),
    ];
    const haystack =
      answers.map((r) => r.body ?? "").join("\n") +
      (reportOf(c, jobId) ?? "") +
      c.log.text() +
      JSON.stringify(c.h.db.audits);
    expect(haystack).not.toContain("fcm-token");
    expect(haystack).not.toContain("APA91b");
    expect(haystack).not.toContain(P1);
    expect(haystack).not.toContain("example-project");
    // Nor does a log line name a recipient.
    for (const n of [1, 2, 3, 4, 5])
      expect(c.log.text()).not.toContain(user(n));
    expect(c.log.text()).toContain("push job");
  });

  it("works in batches: one lookup and one cursor write each, the cursor persisted after every batch", async () => {
    const c = await setup();
    for (let n = 0; n < 25; n++) await putToken(c, n);
    const jobId = await submit(c, csvOf(0, 25));
    const cursors: number[] = [];
    const lookups: number[] = [];
    const jobs = {
      ...c.h.pushJobs,
      advanceJob: async (
        ...args: Parameters<typeof c.h.pushJobs.advanceJob>
      ) => {
        const r = await c.h.pushJobs.advanceJob(...args);
        cursors.push(r?.cursor ?? -1);
        return r;
      },
    };
    const push = {
      ...c.h.push,
      listTokensForUsers: async (channelId: string, ids: readonly string[]) => {
        lookups.push(ids.length);
        return c.h.push.listTokensForUsers(channelId, ids);
      },
    };
    await worker(c, { jobs, push, batchSize: 10 });
    expect(lookups).toEqual([10, 10, 5]);
    expect(cursors).toEqual([10, 20, 25]);
    expect(await jobOf(c, jobId)).toMatchObject({
      status: "done",
      total: 25,
      processed: 25,
      counts: { sent: 25 },
    });
    expect(c.h.fcm.google.sent).toHaveLength(25);
    expect(reportOf(c, jobId)?.split("\n")).toHaveLength(27);
    // One stats call per batch.
    expect([...c.h.push.stats.values()][0]).toMatchObject({
      calls: 3,
      sent: 25,
    });
  });

  it("gives the lease back after its slice and reports runnable work, then resumes at the cursor", async () => {
    const c = await setup();
    for (let n = 0; n < 30; n++) await putToken(c, n);
    const jobId = await submit(c, csvOf(0, 30));
    // Every report write costs 40 s of the clock.
    const slow = {
      ...c.h.pushStore.store,
      put: async (...args: Parameters<typeof c.h.pushStore.store.put>) => {
        c.h.clock.tick(40);
        return c.h.pushStore.store.put(...args);
      },
    };
    // One invocation: the slice (60 s) ends after two batches, and so does
    // the invocation's own budget (70 s).
    const first = await worker(c, {
      store: slow,
      batchSize: 10,
      invocationBudgetMs: 70_000,
    });
    expect(first).toEqual({ claimed: 1, more: true });
    const mid = await jobOf(c, jobId);
    expect(mid).toMatchObject({
      status: "running",
      total: 30,
      processed: 20,
      counts: { sent: 20 },
      report: null,
    });
    const row = c.h.pushJobs.jobs.get(jobId)!;
    expect(row.leaseOwner).toBeNull();
    expect(row.attempts).toBe(0);
    expect(c.h.fcm.google.sent).toHaveLength(20);

    // The next invocation (the self-invoke) picks it up where it stopped.
    const reads = c.h.pushStore.calls.readUpload;
    const second = await worker(c, { batchSize: 10 });
    expect(second).toEqual({ claimed: 1, more: false });
    expect(c.h.pushStore.calls.readUpload).toBeGreaterThan(reads);
    expect(await jobOf(c, jobId)).toMatchObject({
      status: "done",
      processed: 30,
      counts: { sent: 30 },
    });
    // Nobody was sent twice.
    const targets = c.h.fcm.google.sent.map(
      (m) => (m.target as { token: string }).token,
    );
    expect(new Set(targets).size).toBe(30);
    expect(reportOf(c, jobId)?.trim().split("\n")).toHaveLength(31);
  });

  it("always runs one batch per turn, and takes turns between jobs of two channels", async () => {
    const c = await setup();
    for (let n = 0; n < 20; n++) await putToken(c, n);
    const a = await submit(c, csvOf(0, 20));
    const b = await submit(c, csvOf(0, 20));
    const order: string[] = [];
    const jobs = {
      ...c.h.pushJobs,
      advanceJob: async (
        ...args: Parameters<typeof c.h.pushJobs.advanceJob>
      ) => {
        order.push(args[0] === a ? "a" : "b");
        // Each batch outlasts the slice.
        c.h.clock.tick(61);
        return c.h.pushJobs.advanceJob(...args);
      },
    };
    const run = await worker(c, {
      jobs,
      batchSize: 5,
      invocationBudgetMs: 3_600_000,
    });
    // A slice of 60 s is over after one 61 s batch: the jobs alternate.
    expect(order).toEqual(["a", "b", "a", "b", "a", "b", "a", "b"]);
    expect(run).toEqual({ claimed: 8, more: false });
    for (const id of [a, b])
      expect(await jobOf(c, id)).toMatchObject({
        status: "done",
        processed: 20,
      });
  });

  it("stops claiming when the function is about to time out", async () => {
    const c = await setup();
    await submit(c, csvOf(0, 2));
    const run = await worker(c, { remainingMs: () => 100_000 });
    expect(run).toEqual({ claimed: 0, more: true });
  });

  it("two invocations never run one job: the second finds nothing to claim", async () => {
    const c = await setup();
    for (let n = 0; n < 4; n++) await putToken(c, n);
    const jobId = await submit(c, csvOf(0, 4));
    let inner: Awaited<ReturnType<typeof worker>> | undefined;
    const push = {
      ...c.h.push,
      listTokensForUsers: async (channelId: string, ids: readonly string[]) => {
        // While the first worker is inside its batch, a second one starts.
        inner ??= await worker(c, { owner: "w_second" });
        return c.h.push.listTokensForUsers(channelId, ids);
      },
    };
    const run = await worker(c, { push, owner: "w_first" });
    // It found the job held and nothing else: it waited, then left the
    // chain open for whoever outlives the lease.
    expect(inner).toEqual({ claimed: 0, more: true });
    expect(run).toEqual({ claimed: 1, more: false });
    expect(c.h.fcm.google.sent).toHaveLength(4);
    expect(await jobOf(c, jobId)).toMatchObject({ status: "done" });
  });

  it("a crash after the send and before the cursor write repeats that one batch, and no other", async () => {
    const c = await setup();
    for (let n = 0; n < 30; n++) await putToken(c, n);
    const jobId = await submit(c, csvOf(0, 30));
    let calls = 0;
    const dying = {
      ...c.h.pushJobs,
      advanceJob: async (
        ...args: Parameters<typeof c.h.pushJobs.advanceJob>
      ) => {
        // The second batch is out; the process dies before its cursor write.
        if (++calls === 2) throw new Error("container killed");
        return c.h.pushJobs.advanceJob(...args);
      },
      // A killed container releases nothing either.
      releaseJob: async () => false,
    };
    await expect(
      worker(c, { jobs: dying, batchSize: 10, owner: "w_dead" }),
    ).rejects.toThrow("container killed");
    expect(c.h.fcm.google.sent).toHaveLength(20);
    const row = c.h.pushJobs.jobs.get(jobId)!;
    expect(row).toMatchObject({
      status: "running",
      cursor: 10,
      sent: 10,
      leaseOwner: "w_dead",
    });
    // The lease is still held: nothing runs until it expires.
    expect(await worker(c, { batchSize: 10 })).toEqual({
      claimed: 0,
      more: true,
    });
    c.h.clock.tick(301);
    expect(await worker(c, { batchSize: 10 })).toEqual({
      claimed: 1,
      more: false,
    });
    const job = await jobOf(c, jobId);
    expect(job).toMatchObject({
      status: "done",
      processed: 30,
      counts: { sent: 30 },
    });
    // The dead run was counted at the claim; the batches after it cleared it.
    expect(c.h.pushJobs.jobs.get(jobId)!.attempts).toBe(0);
    // 40 messages for 30 users: users 10-19 twice, everyone else once.
    const perUser = new Map<string, number>();
    for (const m of c.h.fcm.google.sent) {
      const t = (m.target as { token: string }).token;
      perUser.set(t, (perUser.get(t) ?? 0) + 1);
    }
    expect(c.h.fcm.google.sent).toHaveLength(40);
    for (let n = 0; n < 30; n++)
      expect(perUser.get(tokenOf(n)), `user ${n}`).toBe(
        n >= 10 && n < 20 ? 2 : 1,
      );
    // The report still holds each row once.
    expect(reportOf(c, jobId)?.trim().split("\n")).toHaveLength(31);
    expect(c.log.text()).toContain("push job lease expired");
  });

  it("gives a job back after an infrastructure error, counted, and fails it after five dead runs", async () => {
    const c = await setup();
    await putToken(c, 0);
    const jobId = await submit(c, csvOf(0, 1));
    c.h.pushStore.failNext.op = "put";
    await expect(worker(c)).rejects.toThrow("push storage error");
    const row = () => c.h.pushJobs.jobs.get(jobId)!;
    expect(row()).toMatchObject({
      status: "running",
      attempts: 1,
      leaseOwner: null,
      cursor: 0,
    });
    expect(row().leaseUntil).toBe(
      Math.floor(c.h.clock.now() / 1000) + PUSH_JOB_RETRY_DELAY_SEC,
    );
    expect(c.log.text()).toContain("push job run failed");
    // Not runnable before the delay: no hot loop. The chain stays open.
    expect(await worker(c)).toEqual({ claimed: 0, more: true });
    for (let i = 1; i < PUSH_JOB_MAX_ATTEMPTS; i++) {
      c.h.clock.tick(PUSH_JOB_RETRY_DELAY_SEC);
      c.h.pushStore.failNext.op = "put";
      await expect(worker(c)).rejects.toThrow();
    }
    expect(row().attempts).toBe(PUSH_JOB_MAX_ATTEMPTS);
    c.h.clock.tick(PUSH_JOB_RETRY_DELAY_SEC);
    expect(await worker(c)).toEqual({ claimed: 1, more: false });
    expect(await jobOf(c, jobId)).toMatchObject({
      status: "failed",
      error: "stalled",
      report: null,
    });
  });

  it("honours a cancel between two batches, and at once for an idle job", async () => {
    const c = await setup();
    for (let n = 0; n < 30; n++) await putToken(c, n);
    const jobId = await submit(c, csvOf(0, 30));
    let batches = 0;
    const jobs = {
      ...c.h.pushJobs,
      advanceJob: async (
        ...args: Parameters<typeof c.h.pushJobs.advanceJob>
      ) => {
        if (++batches === 1) {
          const r = await member(c, "POST", `/jobs/${jobId}/cancel`);
          expect(r.statusCode, r.body).toBe(200);
          expect(parse(r).job).toMatchObject({
            status: "running",
            cancelRequested: true,
          });
        }
        return c.h.pushJobs.advanceJob(...args);
      },
    };
    await worker(c, { jobs, batchSize: 10 });
    const job = await jobOf(c, jobId);
    expect(job).toMatchObject({
      status: "failed",
      error: "canceled",
      cancelRequested: true,
      processed: 10,
      counts: { sent: 10 },
    });
    expect(c.h.fcm.google.sent).toHaveLength(10);
    // What was sent is reported.
    expect(job.report).toMatchObject({ available: true });
    expect(reportOf(c, jobId)?.trim().split("\n")).toHaveLength(11);
    expect(audits(c.h, "push.job.cancel")).toHaveLength(1);
    // Cancelling a finished job changes nothing and audits nothing.
    const again = await member(c, "POST", `/jobs/${jobId}/cancel`);
    expect(parse(again).job).toMatchObject({ status: "failed" });
    expect(audits(c.h, "push.job.cancel")).toHaveLength(1);

    // A queued job: the cancel kicks the worker, which ends it unsent.
    const idle = await submit(c, csvOf(0, 3));
    const kicks = c.h.pushKicks.length;
    const r = await api(c, "POST", `/jobs/${idle}/cancel`);
    expect(parse(r).job).toMatchObject({
      status: "queued",
      cancelRequested: true,
    });
    expect(c.h.pushKicks.length).toBe(kicks + 1);
    await worker(c);
    expect(await jobOf(c, idle)).toMatchObject({
      status: "failed",
      error: "canceled",
      processed: 0,
      report: null,
    });
    expect(c.h.fcm.google.sent).toHaveLength(10);
    expect((await member(c, "POST", "/jobs/pj_none/cancel")).statusCode).toBe(
      404,
    );
  });

  it("fails cleanly when the channel is deleted, expires or is disabled mid-job", async () => {
    for (const [what, error] of [
      ["delete", "channel_gone"],
      ["disable", "channel_inactive"],
      ["expire", "channel_inactive"],
    ] as const) {
      const c = await setup();
      for (let n = 0; n < 30; n++) await putToken(c, n);
      const jobId = await submit(c, csvOf(0, 30));
      let batches = 0;
      const jobs = {
        ...c.h.pushJobs,
        advanceJob: async (
          ...args: Parameters<typeof c.h.pushJobs.advanceJob>
        ) => {
          const r = await c.h.pushJobs.advanceJob(...args);
          if (++batches === 1) {
            const row = c.h.db.channels.get(c.id)!;
            if (what === "delete") row.deletedAt = NOW_SEC;
            if (what === "disable") row.disabledAt = NOW_SEC;
            if (what === "expire") row.expiresAt = NOW_SEC - 1;
          }
          return r;
        },
      };
      expect(await worker(c, { jobs, batchSize: 10 }), what).toEqual({
        claimed: 1,
        more: false,
      });
      expect(c.h.fcm.google.sent, what).toHaveLength(10);
      expect(c.h.pushJobs.jobs.get(jobId), what).toMatchObject({
        status: "failed",
        error,
        cursor: 10,
        sent: 10,
      });
      // The first batch's rows are still reported.
      expect(reportOf(c, jobId)?.trim().split("\n"), what).toHaveLength(11);
    }
    // A channel that is gone before the first batch: nothing is read.
    const c = await setup();
    const jobId = await submit(c, csvOf(0, 3));
    c.h.db.channels.get(c.id)!.deletedAt = NOW_SEC;
    const reads = c.h.pushStore.calls.readUpload;
    await worker(c);
    expect(c.h.pushStore.calls.readUpload).toBe(reads);
    expect(c.h.pushJobs.jobs.get(jobId)).toMatchObject({
      status: "failed",
      error: "channel_gone",
    });
  });

  it("fails the job, without a hot loop, when FCM refuses the platform's key", async () => {
    const c = await setup();
    for (let n = 0; n < 30; n++) await putToken(c, n);
    const jobId = await submit(c, csvOf(0, 30));
    c.h.fcm.google.failNext("send", { status: 403 }, { times: 1000 });
    const run = await worker(c, { batchSize: 10 });
    expect(run).toEqual({ claimed: 1, more: false });
    const job = await jobOf(c, jobId);
    expect(job).toMatchObject({
      status: "failed",
      error: "sender_unavailable",
      processed: 10,
      counts: { sent: 0, failed: 10 },
    });
    expect(c.h.fcm.google.sent).toHaveLength(0);
    // The first refusal ends the batch's requests, and no second batch runs.
    expect(c.h.fcm.google.calls.send).toBeLessThanOrEqual(20);
    expect(reportOf(c, jobId)).toContain(`${user(0)},failed,unavailable\n`);
    expect(c.log.text()).toContain('error push sender refused {"slot":"p1"}');
    // Nothing left to run: the worker does not come back for it.
    expect(await worker(c)).toEqual({ claimed: 0, more: false });
  });

  it("fails at start when the pool is gone, and keeps sending for the platform when the team key is refused", async () => {
    const c = await setup();
    await putToken(c, 0);
    const lost = await submit(c, csvOf(0, 1));
    await worker(c, { pool: undefined });
    expect(c.h.pushJobs.jobs.get(lost)).toMatchObject({
      status: "failed",
      error: "sender_unavailable",
      cursor: 0,
    });
    const unreg = await submit(c, csvOf(0, 1));
    await c.h.db.editChannel(c.id, (cur) => {
      const config = JSON.parse(cur.configJson);
      const kept = { slot: config.slot, firebaseAppId: config.firebaseAppId };
      delete config.slot;
      delete config.firebaseAppId;
      c.h.db.channels.get(c.id)!.name = JSON.stringify(kept);
      return { config, secret: JSON.parse(cur.secretJson) };
    });
    await worker(c);
    expect(c.h.pushJobs.jobs.get(unreg)).toMatchObject({
      status: "failed",
      error: "not_registered",
    });

    // A channel with both senders: the team's key is revoked.
    const d = await setup();
    const account = d.h.fcm.google.serviceAccountJson(TEAM_PROJECT, {
      clientEmail: "team@example-team-project.iam.gserviceaccount.com",
    });
    const set = await send(
      d.h,
      ev("PUT", `/channels/${d.id}/sender-key`, {
        headers: d.a.cookie,
        body: { serviceAccount: account },
      }),
    );
    expect(set.statusCode, set.body).toBe(200);
    await putToken(d, 0);
    await putToken(d, 1, 0, TEAM_PROJECT);
    // A token of a project the channel holds no key for.
    await putToken(d, 2, 0, "example-other-project");
    d.h.fcm.google.revokeKey(
      "team@example-team-project.iam.gserviceaccount.com",
    );
    const jobId = await submit(d, csvOf(0, 3));
    await worker(d);
    expect(await jobOf(d, jobId)).toMatchObject({
      status: "done",
      counts: { sent: 1, failed: 2 },
    });
    expect(reportOf(d, jobId)).toBe(
      "userId,status,reason\n" +
        `${user(0)},sent,\n` +
        `${user(1)},failed,rejected\n` +
        `${user(2)},failed,rejected\n`,
    );
    expect(d.log.text()).toContain("push team sender refused");
  });

  it("refuses a file over push.recipientsPerJob before anything is sent, with the limit named", async () => {
    const c = await setup();
    for (let n = 0; n < 12; n++) await putToken(c, n);
    const boss = await c.h.login("Boss", "admin");
    // No grant below the soft value exists, so the worker is given a tiny
    // limit through its own view of the overrides.
    const limits = {
      listOverrides: async () => [
        {
          id: "lo_1",
          teamId: c.a.teamId,
          scope: { kind: "channel" as const, id: c.id },
          key: "push.recipientsPerJob",
          value: 10,
          expiresAt: null,
          note: "",
          requestId: null,
          grantedBy: boss.id,
          grantedAt: NOW_SEC,
        },
      ],
    };
    const over = await submit(c, csvOf(0, 11));
    const exact = await submit(c, csvOf(0, 10));
    await worker(c, { limits });
    expect(await jobOf(c, over)).toMatchObject({
      status: "failed",
      error: "recipients_over_limit",
      errorDetails: { limit: "push.recipientsPerJob", value: 10 },
      total: null,
      processed: 0,
      report: null,
    });
    expect(await jobOf(c, exact)).toMatchObject({
      status: "done",
      total: 10,
      counts: { sent: 10 },
    });
    expect(c.h.fcm.google.sent).toHaveLength(10);
  });

  it("fails a malformed file whole, at the line, before anything is sent", async () => {
    const c = await setup();
    for (let n = 0; n < 5; n++) await putToken(c, n);
    const cases: [string, Record<string, unknown>][] = [
      [
        `userId,name\n${user(0)},a\n${user(1)}\n`,
        { reason: "column_count", line: 3 },
      ],
      [
        `userId,name\n${user(0)},a\n${user(1)},"b\n`,
        { reason: "unterminated_quote", line: 3 },
      ],
      [
        `userId,name\n${user(0)},${"x".repeat(600)}\n`,
        { reason: "field_too_long", line: 2 },
      ],
      ["userId,name\n", { reason: "no_rows", line: 1 }],
      ["userId,name\n\n\n", { reason: "no_rows", line: 1 }],
    ];
    for (const [csv, detail] of cases) {
      const jobId = await submit(c, csv);
      await worker(c);
      expect(await jobOf(c, jobId), csv.slice(0, 40)).toMatchObject({
        status: "failed",
        error: "csv_invalid",
        errorDetails: detail,
        processed: 0,
        report: null,
      });
    }
    expect(c.h.fcm.google.sent).toHaveLength(0);
  });

  it("fails when the upload is gone or was replaced after the submit", async () => {
    const c = await setup();
    await putToken(c, 0);
    const gone = await submit(c, csvOf(0, 1));
    const row = c.h.pushJobs.jobs.get(gone)!;
    c.h.pushStore.objects.delete(pushUploadKey(c.id, row.uploadId!));
    await worker(c);
    expect(await jobOf(c, gone)).toMatchObject({
      status: "failed",
      error: "upload_missing",
    });

    const swapped = await submit(c, csvOf(0, 1));
    const key = pushUploadKey(c.id, c.h.pushJobs.jobs.get(swapped)!.uploadId!);
    // The presigned URL is still valid: somebody PUTs another file.
    c.h.pushStore.upload(key, csvOf(5, 6));
    await worker(c);
    expect(await jobOf(c, swapped)).toMatchObject({
      status: "failed",
      error: "upload_changed",
    });
    expect(c.h.fcm.google.sent).toHaveLength(0);

    // Replaced between two reads of one run.
    const mid = await submit(c, csvOf(0, 1));
    const midKey = pushUploadKey(c.id, c.h.pushJobs.jobs.get(mid)!.uploadId!);
    let reads = 0;
    const store = {
      ...c.h.pushStore.store,
      readUpload: async (
        ...args: Parameters<typeof c.h.pushStore.store.readUpload>
      ) => {
        if (++reads === 2) c.h.pushStore.upload(midKey, csvOf(7, 8));
        return c.h.pushStore.store.readUpload(...args);
      },
    };
    await worker(c, { store });
    expect(await jobOf(c, mid)).toMatchObject({
      status: "failed",
      error: "upload_changed",
    });
    expect(c.h.fcm.google.sent).toHaveLength(0);
  });

  it("reports a row whose rendered message is too large, and sends the rest", async () => {
    const c = await setup();
    for (let n = 0; n < 2; n++) await putToken(c, n);
    const jobId = await submit(
      c,
      `userId,name\n${user(0)},${"x".repeat(500)}\n${user(1)},ok\n`,
      { template: { title: "T", body: `${"y".repeat(3600)}{{name}}` } },
    );
    await worker(c);
    expect(await jobOf(c, jobId)).toMatchObject({
      status: "done",
      counts: { sent: 1, invalid: 1, skipped: 1 },
    });
    expect(reportOf(c, jobId)).toContain(`${user(0)},skipped,too-large\n`);
  });

  it("pauses after a batch FCM answered with a quota error, and reports those users failed", async () => {
    const c = await setup();
    for (let n = 0; n < 4; n++) await putToken(c, n);
    const jobId = await submit(c, csvOf(0, 4));
    // Every attempt of the first batch's messages is a 429.
    c.h.fcm.google.failNext("send", { status: 429 }, { times: 6 });
    const pauses: number[] = [];
    await worker(c, {
      batchSize: 2,
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    expect(pauses).toEqual([PUSH_JOB_QUOTA_PAUSE_MS]);
    expect(await jobOf(c, jobId)).toMatchObject({
      status: "done",
      counts: { sent: 2, failed: 2 },
    });
    expect(reportOf(c, jobId)).toContain(`${user(0)},failed,unavailable\n`);
  });

  it("reads a large file in ranged chunks and rebuilds the duplicate set on resume", async () => {
    const c = await setup();
    for (let n = 0; n < 6; n++) await putToken(c, n);
    // Users 0-5, then 0-5 again: the second half are duplicates.
    const csv =
      csvOf(0, 6) +
      Array.from({ length: 6 }, (_, i) => `${user(i)},again\n`).join("");
    const jobId = await submit(c, csv);
    const slow = {
      ...c.h.pushStore.store,
      put: async (...args: Parameters<typeof c.h.pushStore.store.put>) => {
        c.h.clock.tick(61);
        return c.h.pushStore.store.put(...args);
      },
    };
    // One batch per invocation, 64-byte reads.
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const r = await worker(c, {
        store: slow,
        batchSize: 4,
        readChunkBytes: 64,
        invocationBudgetMs: 1,
      });
      runs.push(r.more);
      if (!r.more) break;
    }
    expect(runs).toEqual([true, true, false]);
    expect(await jobOf(c, jobId)).toMatchObject({
      status: "done",
      total: 12,
      processed: 12,
      counts: { sent: 6, duplicates: 6, skipped: 6 },
    });
    expect(c.h.fcm.google.sent).toHaveLength(6);
  });
});

/* ------------------------------------------------------------------ */
/* Broadcast                                                           */
/* ------------------------------------------------------------------ */

describe("push broadcast", () => {
  it("sends one message to the channel's topic, whatever the audience", async () => {
    const c = await setup();
    for (let n = 0; n < 50; n++) await putToken(c, n);
    const r = await member(c, "POST", "/broadcast", {
      title: "Maintenance",
      body: "Back at 10:00",
      data: { kind: "notice" },
      idempotencyKey: "notice-1",
      priority: "high",
    });
    expect(r.statusCode, r.body).toBe(202);
    const { job } = parse(r);
    expect(job).toMatchObject({
      kind: "broadcast",
      dryRun: false,
      status: "queued",
      templateId: null,
      uploadId: null,
      message: {
        title: "Maintenance",
        body: "Back at 10:00",
        data: { kind: "notice" },
      },
    });
    expect(audits(c.h, "push.broadcast")).toHaveLength(1);
    expect(await worker(c)).toEqual({ claimed: 1, more: false });
    expect(c.h.fcm.google.sent).toEqual([
      expect.objectContaining({
        projectId: P1,
        target: { topic: `yyt.push.${c.id}` },
        notification: { title: "Maintenance", body: "Back at 10:00" },
        data: { kind: "notice" },
        priority: "high",
      }),
    ]);
    expect(pushChannelTopic(c.id)).toBe(`yyt.push.${c.id}`);
    expect(await jobOf(c, job.id)).toMatchObject({
      status: "done",
      total: 1,
      processed: 1,
      counts: { sent: 1, failed: 0 },
      report: null,
    });
    // No token was read for it.
    expect(c.h.push.stats.size).toBe(0);
    // The channel view names the topic for the client.
    const view = parse(
      await send(c.h, ev("GET", `/channels/${c.id}`, { headers: c.a.cookie })),
    );
    expect(view.topic).toBe(`yyt.push.${c.id}`);
    // A broadcast has no report.
    const rep = await member(c, "GET", `/jobs/${job.id}/report`);
    expect(rep.statusCode).toBe(409);
    expect(errorOf(rep).details).toEqual({ reason: "report_absent" });
  });

  it("sends one message per project when the channel also holds a team key", async () => {
    const c = await setup();
    const account = c.h.fcm.google.serviceAccountJson(TEAM_PROJECT);
    const set = await send(
      c.h,
      ev("PUT", `/channels/${c.id}/sender-key`, {
        headers: c.a.cookie,
        body: { serviceAccount: account },
      }),
    );
    expect(set.statusCode, set.body).toBe(200);
    const templateId = await makeTemplate(c, { title: "Hello all" });
    const r = await api(c, "POST", "/broadcast", {
      templateId,
      idempotencyKey: "b-1",
    });
    expect(r.statusCode, r.body).toBe(202);
    expect(parse(r).job).toMatchObject({ author: "apikey", templateId });
    await worker(c);
    const topic = `yyt.push.${c.id}`;
    expect(
      c.h.fcm.google.sent.map((m) => [m.projectId, m.target]).sort(),
    ).toEqual([
      [P1, { topic }],
      [TEAM_PROJECT, { topic }],
    ]);
    expect(await jobOf(c, parse(r).job.id)).toMatchObject({
      status: "done",
      total: 2,
      counts: { sent: 2 },
    });
  });

  it("does not repeat a project's message when a run dies between two projects", async () => {
    const c = await setup();
    await send(
      c.h,
      ev("PUT", `/channels/${c.id}/sender-key`, {
        headers: c.a.cookie,
        body: {
          serviceAccount: c.h.fcm.google.serviceAccountJson(TEAM_PROJECT),
        },
      }),
    );
    const r = await member(c, "POST", "/broadcast", {
      title: "T",
      idempotencyKey: "b",
    });
    const jobId = parse(r).job.id;
    let calls = 0;
    const dying = {
      ...c.h.pushJobs,
      advanceJob: async (
        ...args: Parameters<typeof c.h.pushJobs.advanceJob>
      ) => {
        const out = await c.h.pushJobs.advanceJob(...args);
        if (++calls === 1) throw new Error("container killed");
        return out;
      },
      releaseJob: async () => false,
    };
    await expect(worker(c, { jobs: dying })).rejects.toThrow();
    expect(c.h.fcm.google.sent).toHaveLength(1);
    c.h.clock.tick(301);
    await worker(c);
    expect(c.h.fcm.google.sent.map((m) => m.projectId).sort()).toEqual([
      P1,
      TEAM_PROJECT,
    ]);
    expect(await jobOf(c, jobId)).toMatchObject({
      status: "done",
      counts: { sent: 2 },
    });
  });

  it("refuses a message with variables, both or neither source, and bad text", async () => {
    const c = await setup();
    const withVars = await makeTemplate(c, { title: "Hi {{name}}" });
    const post = (body: Record<string, unknown>) =>
      member(c, "POST", "/broadcast", { idempotencyKey: "k", ...body });
    const vars = await post({ templateId: withVars });
    expect(vars.statusCode).toBe(400);
    expect(errorOf(vars).details).toEqual({ reason: "template_has_variables" });
    const inlineVars = await post({ title: "Hi {{name}}" });
    expect(errorOf(inlineVars).details).toEqual({
      reason: "template_has_variables",
    });
    expect((await post({})).statusCode).toBe(400);
    expect((await post({ templateId: withVars, title: "T" })).statusCode).toBe(
      400,
    );
    expect((await post({ body: "no title" })).statusCode).toBe(400);
    expect((await post({ title: "T", data: { from: "x" } })).statusCode).toBe(
      400,
    );
    expect((await post({ templateId: "pt_none" })).statusCode).toBe(404);
    expect(
      (await post({ title: "T", idempotencyKey: undefined })).statusCode,
    ).toBe(400);
    expect(c.h.pushJobs.jobs.size).toBe(0);
    // Idempotency as for a job.
    expect((await post({ title: "T" })).statusCode).toBe(202);
    expect((await post({ title: "T" })).statusCode).toBe(200);
    expect((await post({ title: "Other" })).statusCode).toBe(409);
  });

  it("fails when no project takes the message, and names a refused platform key", async () => {
    const c = await setup();
    const a = parse(
      await member(c, "POST", "/broadcast", {
        title: "T",
        idempotencyKey: "a",
      }),
    ).job.id;
    c.h.fcm.google.failNext("send", { status: 400 });
    await worker(c);
    expect(await jobOf(c, a)).toMatchObject({
      status: "failed",
      error: "send_failed",
      counts: { sent: 0, failed: 1 },
    });
    const b = parse(
      await member(c, "POST", "/broadcast", {
        title: "T",
        idempotencyKey: "b",
      }),
    ).job.id;
    c.h.fcm.google.failNext("send", { status: 403 }, { times: 5 });
    await worker(c);
    expect(await jobOf(c, b)).toMatchObject({
      status: "failed",
      error: "sender_unavailable",
    });
    expect(c.log.text()).toContain("push broadcast refused");
  });
});

/* ------------------------------------------------------------------ */
/* Report and status                                                   */
/* ------------------------------------------------------------------ */

describe("push job report and status", () => {
  it("offers the report through a presigned GET for seven days", async () => {
    const c = await setup();
    await putToken(c, 0);
    const jobId = await submit(c, csvOf(0, 2));
    const early = await member(c, "GET", `/jobs/${jobId}/report`);
    expect(early.statusCode).toBe(409);
    expect(errorOf(early).details).toEqual({ reason: "report_not_ready" });
    await worker(c);
    const r = await member(c, "GET", `/jobs/${jobId}/report`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers?.["cache-control"]).toBe("no-store");
    const rep = parse(r);
    const asked = Math.floor(c.h.clock.now() / 1000);
    const finishedAt = (await jobOf(c, jobId)).finishedAt;
    expect(rep.url).toContain(`push-reports/${c.id}/${jobId}.csv`);
    expect(rep.url).toContain(`push-report-${jobId}.csv`);
    expect(rep.reportExpiresAt).toBe(finishedAt + PUSH_REPORT_TTL_SEC);
    expect(rep.expiresAt - asked).toBe(300);
    // The apiKey reads it too.
    expect((await api(c, "GET", `/jobs/${jobId}/report`)).statusCode).toBe(200);
    expect((await member(c, "GET", "/jobs/pj_none/report")).statusCode).toBe(
      404,
    );

    // The member's session does not live seven days; the key does, on a
    // channel that does not expire meanwhile.
    c.h.db.channels.get(c.id)!.expiresAt = NOW_SEC + 100 * 86_400;
    c.h.clock.tick(PUSH_REPORT_TTL_SEC - 10);
    expect((await api(c, "GET", `/jobs/${jobId}/report`)).statusCode).toBe(200);
    c.h.clock.tick(10);
    const late = await api(c, "GET", `/jobs/${jobId}/report`);
    expect(late.statusCode).toBe(410);
    expect(errorOf(late).message).toBe("the report expired");
    expect(
      parse(await api(c, "GET", `/jobs/${jobId}`)).job.report,
    ).toMatchObject({ available: false });

    const bare = await setup({ pushJobStore: undefined });
    await bare.h.pushJobs.submitJob(
      {
        id: "pj_x",
        channelId: bare.id,
        kind: "broadcast",
        dryRun: false,
        idempotencyKey: "k",
        paramsHash: "0".repeat(64),
        templateId: null,
        title: "T",
        body: "",
        data: {},
        options: {},
        uploadId: null,
        uploadEtag: null,
        day: DAY,
        author: "apikey",
        at: NOW_SEC,
      },
      10,
    );
    const claim = await bare.h.pushJobs.claimJob({
      owner: "w",
      now: NOW_SEC,
      leaseSec: 5,
    });
    await bare.h.pushJobs.finishJob(claim!.job.id, "w", {
      status: "done",
      reportAt: NOW_SEC,
      at: NOW_SEC,
    });
    expect((await member(bare, "GET", "/jobs/pj_x/report")).statusCode).toBe(
      503,
    );
  });

  it("pages the job list newest first", async () => {
    const c = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await submit(c, csvOf(0, 1)));
    const page = async (query: Record<string, string>) =>
      parse(
        await send(
          c.h,
          ev("GET", `/channels/${c.id}/push/jobs`, {
            headers: c.a.cookie,
            query,
          }),
        ),
      );
    const first = await page({ limit: "2" });
    expect(first.jobs.map((j: { id: string }) => j.id)).toEqual([
      ids[4],
      ids[3],
    ]);
    expect(first.next).toBeTruthy();
    const second = await page({ limit: "2", cursor: first.next });
    expect(second.jobs.map((j: { id: string }) => j.id)).toEqual([
      ids[2],
      ids[1],
    ]);
    const third = await page({ limit: "2", cursor: second.next });
    expect(third.jobs.map((j: { id: string }) => j.id)).toEqual([ids[0]]);
    expect(third.next).toBeNull();
    const badQueries: Record<string, string>[] = [
      { limit: "0" },
      { limit: "101" },
      { cursor: "x" },
    ];
    for (const query of badQueries)
      expect(
        (
          await send(
            c.h,
            ev("GET", `/channels/${c.id}/push/jobs`, {
              headers: c.a.cookie,
              query,
            }),
          )
        ).statusCode,
      ).toBe(400);
    // The apiKey lists the same jobs.
    const viaKey = parse(await api(c, "GET", "/jobs"));
    expect(viaKey.jobs).toHaveLength(5);
  });

  it("a status read kicks the worker for a job that sat idle a minute, once a minute", async () => {
    const c = await setup();
    const jobId = await submit(c, csvOf(0, 1));
    const kicks = () => c.h.pushKicks.length;
    const before = kicks();
    await jobOf(c, jobId);
    expect(kicks()).toBe(before);
    c.h.clock.tick(61);
    await jobOf(c, jobId);
    expect(kicks()).toBe(before + 1);
    await jobOf(c, jobId);
    await api(c, "GET", `/jobs/${jobId}`);
    expect(kicks()).toBe(before + 1);
    c.h.clock.tick(61);
    await api(c, "GET", `/jobs/${jobId}`);
    expect(kicks()).toBe(before + 2);
    // A job a worker holds is left alone.
    await c.h.pushJobs.claimJob({
      owner: "w",
      now: Math.floor(c.h.clock.now() / 1000),
      leaseSec: 600,
    });
    c.h.clock.tick(120);
    await jobOf(c, jobId);
    expect(kicks()).toBe(before + 2);
    // A finished one too.
    await c.h.pushJobs.finishJob(jobId, "w", { status: "done", at: NOW_SEC });
    c.h.clock.tick(120);
    await jobOf(c, jobId);
    expect(kicks()).toBe(before + 2);
  });

  it("records the job even when the kick fails", async () => {
    const c = await setup({
      pushJobInvoke: async () => {
        throw new Error("lambda throttled");
      },
    });
    const jobId = await submit(c, csvOf(0, 1));
    expect(c.h.pushJobs.jobs.get(jobId)?.status).toBe("queued");
    expect(c.log.text()).toContain("push job kick failed");
  });
});

/* ------------------------------------------------------------------ */
/* The apiKey family                                                   */
/* ------------------------------------------------------------------ */

describe("push campaign apiKey routes", () => {
  it("runs a whole campaign with the channel's apiKey and records the author as apikey", async () => {
    const c = await setup();
    await putToken(c, 0);
    const templateId = await makeTemplate(c);
    const up = await api(c, "POST", "/uploads", { size: 0 });
    expect(up.statusCode).toBe(400);
    const csv = csvOf(0, 2);
    const issued = await api(c, "POST", "/uploads", {
      size: Buffer.byteLength(csv),
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const { uploadId } = parse(issued);
    expect(await c.h.pushJobs.findUpload(c.id, uploadId)).toMatchObject({
      createdBy: "apikey",
    });
    c.h.pushStore.upload(pushUploadKey(c.id, uploadId), csv);

    const dry = await api(c, "POST", "/jobs", {
      templateId,
      uploadId,
      idempotencyKey: "dry",
      dryRun: true,
    });
    expect(dry.statusCode, dry.body).toBe(202);
    await worker(c);
    expect(
      parse(await api(c, "GET", `/jobs/${parse(dry).job.id}`)).job,
    ).toMatchObject({
      status: "done",
      author: "apikey",
      counts: { resolved: 1, noToken: 1, sent: 0 },
    });
    const real = await api(c, "POST", "/jobs", {
      templateId,
      uploadId,
      idempotencyKey: "real",
    });
    expect(real.statusCode).toBe(202);
    await worker(c);
    const job = parse(await api(c, "GET", `/jobs/${parse(real).job.id}`)).job;
    expect(job).toMatchObject({ status: "done", counts: { sent: 1 } });
    expect(audits(c.h, "push.job.submit")).toMatchObject([
      { actorId: null, detail: { via: "apikey", dryRun: true } },
      { actorId: null, detail: { via: "apikey", dryRun: false } },
    ]);
    // The member sees the apiKey's jobs.
    expect(parse(await member(c, "GET", "/jobs")).jobs).toHaveLength(2);
  });

  it("takes the channel's own apiKey as a bearer and nothing else", async () => {
    const c = await setup();
    const other = await setup();
    const jobId = await submit(c, csvOf(0, 1));
    const routes: [string, string, unknown?][] = [
      ["POST", "/uploads", { size: 10 }],
      [
        "POST",
        "/jobs",
        { templateId: "t", uploadId: "u", idempotencyKey: "k" },
      ],
      ["GET", "/jobs"],
      ["GET", `/jobs/${jobId}`],
      ["POST", `/jobs/${jobId}/cancel`],
      ["GET", `/jobs/${jobId}/report`],
      ["POST", "/broadcast", { title: "T", idempotencyKey: "k" }],
    ];
    for (const [method, path, body] of routes) {
      const label = `${method} ${path}`;
      // No credential, a wrong key, another channel's key, a prefix of the key.
      for (const key of [
        null,
        "0".repeat(64),
        other.key,
        c.key.slice(0, 32),
        `${c.key}0`,
      ]) {
        const r = await api(c, method, path, body, key);
        expect(r.statusCode, `${label} ${String(key).slice(0, 8)}`).toBe(401);
        expect(errorOf(r).message).toBe("api key required");
      }
      // A member's session is no credential on this family.
      const cookie = await send(
        c.h,
        ev(method, `/push-api/${c.id}${path}`, {
          headers: c.a.cookie,
          ...(body === undefined ? {} : { body }),
        }),
      );
      expect(cookie.statusCode, `${label} cookie`).toBe(401);
      // No such channel, and a channel of another kind.
      for (const id of ["push_0000000000000000", c.auth]) {
        const r = await send(
          c.h,
          ev(method, `/push-api/${id}${path}`, {
            headers: { authorization: `Bearer ${c.key}` },
            ...(body === undefined ? {} : { body }),
          }),
        );
        // As a wrong key: the family does not say which channels exist.
        expect(r.statusCode, `${label} ${id}`).toBe(401);
        expect(errorOf(r).message).toBe("api key required");
      }
    }
    // The key reaches its own channel's jobs only.
    expect((await api(other, "GET", `/jobs/${jobId}`)).statusCode).toBe(404);
    // No CORS header on any answer: the family is for servers.
    const ok = await api(c, "GET", "/jobs");
    expect(ok.statusCode).toBe(200);
    expect(
      Object.keys(ok.headers ?? {}).filter((k) =>
        k.toLowerCase().startsWith("access-control"),
      ),
    ).toEqual([]);
    // A rotated key stops at once.
    const rotated = await send(
      c.h,
      ev("POST", `/channels/${c.id}/rotate-secret`, { headers: c.a.cookie }),
    );
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect((await api(c, "GET", "/jobs")).statusCode).toBe(401);
    expect(
      (await api(c, "GET", "/jobs", undefined, parse(rotated).apiKey))
        .statusCode,
    ).toBe(200);
  });

  it("answers 410 on an expired or disabled channel, for the key and for a member's submit", async () => {
    const c = await setup();
    const templateId = await makeTemplate(c);
    const uploadId = await upload(c, csvOf(0, 1));
    c.h.db.channels.get(c.id)!.disabledAt = NOW_SEC;
    expect((await api(c, "GET", "/jobs")).statusCode).toBe(410);
    expect((await api(c, "POST", "/uploads", { size: 5 })).statusCode).toBe(
      410,
    );
    // The wrong key is still a 401, not a 410.
    expect(
      (await api(c, "GET", "/jobs", undefined, "0".repeat(64))).statusCode,
    ).toBe(401);
    for (const [path, body] of [
      ["/uploads", { size: 5 }],
      ["/jobs", { templateId, uploadId, idempotencyKey: "k" }],
      ["/broadcast", { title: "T", idempotencyKey: "k" }],
    ] as const)
      expect((await member(c, "POST", path, body)).statusCode, path).toBe(410);
    // A member still reads what the channel did.
    expect((await member(c, "GET", "/jobs")).statusCode).toBe(200);
    expect((await member(c, "GET", "/templates")).statusCode).toBe(200);
  });

  it("limits writes to one per 500 ms per channel, whoever holds the key", async () => {
    const c = await setup();
    c.h.clock.tick(5);
    // A write that changes nothing still takes the slot before it looks.
    const post = () =>
      c.h.app(
        ev("POST", `/push-api/${c.id}/jobs/pj_none/cancel`, {
          headers: { authorization: `Bearer ${c.key}` },
        }),
      );
    expect((await post()).statusCode).toBe(404);
    const second = await post();
    expect(second.statusCode).toBe(429);
    expect(errorOf(second).details).toEqual({ retryAfterMs: 500 });
    // The member's slot is another one.
    expect(
      (
        await c.h.app(
          ev("POST", `/channels/${c.id}/push/jobs/pj_none/cancel`, {
            headers: c.a.cookie,
          }),
        )
      ).statusCode,
    ).toBe(404);
    // Reads are not writes.
    expect(
      (
        await c.h.app(
          ev("GET", `/push-api/${c.id}/jobs`, {
            headers: { authorization: `Bearer ${c.key}` },
          }),
        )
      ).statusCode,
    ).toBe(200);
    c.h.clock.tick(1);
    expect((await post()).statusCode).toBe(404);
  });

  it("an upload takes no write slot, so the submit that follows it is not throttled", async () => {
    const c = await setup();
    const templateId = await makeTemplate(c);
    c.h.clock.tick(5);
    const csv = csvOf(0, 1);
    const call = (path: string, body: unknown) =>
      c.h.app(
        ev("POST", `/push-api/${c.id}${path}`, {
          headers: { authorization: `Bearer ${c.key}` },
          body,
        }),
      );
    // Two uploads and a submit inside one 500 ms slot.
    const first = await call("/uploads", { size: Buffer.byteLength(csv) });
    const spare = await call("/uploads", { size: 10 });
    expect([first.statusCode, spare.statusCode]).toEqual([201, 201]);
    const uploadId = parse(first).uploadId as string;
    c.h.pushStore.upload(pushUploadKey(c.id, uploadId), csv);
    const job = await call("/jobs", {
      templateId,
      uploadId,
      idempotencyKey: "same-slot",
      dryRun: true,
    });
    expect(job.statusCode, job.body).toBe(202);
    // The submit took the slot: the next write waits.
    const del = await c.h.app(
      ev("DELETE", `/push-api/${c.id}/uploads/${parse(spare).uploadId}`, {
        headers: { authorization: `Bearer ${c.key}` },
      }),
    );
    expect(del.statusCode).toBe(429);
  });
});

/* ------------------------------------------------------------------ */
/* Sweep, digest, channel delete                                       */
/* ------------------------------------------------------------------ */

describe("push campaign upkeep", () => {
  it("a channel delete drains its jobs, uploads, objects and templates", async () => {
    const c = await setup();
    await putToken(c, 0);
    const jobId = await submit(c, csvOf(0, 1));
    await worker(c);
    await upload(c, csvOf(0, 1));
    expect(c.h.pushJobs.jobs.size).toBe(1);
    expect(c.h.pushJobs.uploads.size).toBe(2);
    expect(c.h.pushStore.objects.size).toBe(3);
    const del = await send(
      c.h,
      ev("DELETE", `/channels/${c.id}`, { headers: c.a.cookie }),
    );
    expect(del.statusCode, del.body).toBe(204);
    expect(c.h.pushJobs.jobs.size).toBe(0);
    expect(c.h.pushJobs.uploads.size).toBe(0);
    expect(c.h.pushStore.objects.size).toBe(0);
    expect(reportOf(c, jobId)).toBeUndefined();
    // The key stops with the channel.
    expect((await api(c, "GET", "/jobs")).statusCode).toBe(401);
  });

  it("the drain is bounded and never throws", async () => {
    const c = await setup();
    for (let i = 0; i < 5; i++) await submit(c, csvOf(0, 1));
    const deleted = await drainPushCampaign(
      c.h.pushJobs,
      c.h.pushStore.store,
      c.id,
      c.log.logger,
      2,
      2,
    );
    // Two statements of two rows for jobs, two for uploads.
    expect(deleted).toBe(8);
    expect(c.log.text()).toContain("push campaign purge truncated");
    c.h.pushStore.failNext.op = "list";
    expect(
      await drainPushCampaign(
        c.h.pushJobs,
        c.h.pushStore.store,
        c.id,
        c.log.logger,
      ),
    ).toBe(2);
    expect(c.log.text()).toContain("push campaign purge failed");
    expect(
      await drainPushCampaign(undefined, undefined, c.id, c.log.logger),
    ).toBe(0);
    expect(
      await drainPushCampaign(c.h.pushJobs, undefined, c.id, c.log.logger),
    ).toBe(0);
  });

  it("the daily sweep removes old uploads with their objects, expires stuck jobs, trims finished ones and kicks the worker", async () => {
    const c = await setup();
    await putToken(c, 0);
    const done = await submit(c, csvOf(0, 1));
    await worker(c);
    const stuck = await submit(c, csvOf(0, 1));
    const doneUpload = c.h.pushJobs.jobs.get(done)!.uploadId!;
    const stuckUpload = c.h.pushJobs.jobs.get(stuck)!.uploadId!;
    const sweep = (over: Partial<Parameters<typeof runPushJobSweep>[0]> = {}) =>
      runPushJobSweep({
        jobs: c.h.pushJobs,
        store: c.h.pushStore.store,
        invoke: async () => {
          c.h.pushKicks.push(-1);
        },
        clock: c.h.clock,
        logger: c.log.logger,
        ...over,
      });

    // Day 0: nothing is old; the queued job gets the worker kicked.
    expect(await sweep()).toEqual({
      channelRows: 0,
      uploads: 0,
      expired: 0,
      swept: 0,
      stale: 0,
      kicked: true,
      truncated: false,
      failed: [],
    });
    expect(c.h.pushKicks.at(-1)).toBe(-1);

    // Past the upload retention: the finished job's upload goes, object
    // first; the one the stuck job still reads stays.
    c.h.clock.tick(PUSH_UPLOAD_RETAIN_SEC + 1);
    // The job nobody claimed for two days is counted as stale.
    expect(await sweep()).toMatchObject({
      uploads: 1,
      expired: 0,
      stale: 1,
      kicked: true,
    });
    expect(c.h.pushJobs.uploads.has(doneUpload)).toBe(false);
    expect(c.h.pushStore.objects.has(pushUploadKey(c.id, doneUpload))).toBe(
      false,
    );
    expect(c.h.pushJobs.uploads.has(stuckUpload)).toBe(true);

    // Past the job age cap: the stuck job is failed, its upload is free.
    c.h.clock.tick(PUSH_JOB_MAX_AGE_SEC - PUSH_UPLOAD_RETAIN_SEC);
    expect(await sweep()).toMatchObject({
      uploads: 0,
      expired: 1,
      stale: 0,
      kicked: false,
    });
    expect(c.h.pushJobs.jobs.get(stuck)).toMatchObject({
      status: "failed",
      error: "expired",
    });
    expect(await sweep()).toMatchObject({ uploads: 1, expired: 0 });
    expect(c.h.pushJobs.uploads.size).toBe(0);

    // Past the retention: the rows go, and with them their keys.
    c.h.clock.tick(PUSH_JOB_RETAIN_SEC + 1);
    expect(await sweep()).toMatchObject({ swept: 2 });
    expect(c.h.pushJobs.jobs.size).toBe(0);
    expect(c.log.text()).toContain("info push job sweep ");
  });

  it("the sweep drains dead push channels, isolates a failing phase and reports truncation", async () => {
    const c = await setup();
    for (let i = 0; i < 3; i++) await submit(c, csvOf(0, 1));
    const r = await runPushJobSweep({
      jobs: c.h.pushJobs,
      store: c.h.pushStore.store,
      deleted: [{ id: c.id }],
      purged: [{ id: c.auth }, { id: c.id }],
      clock: c.h.clock,
      logger: c.log.logger,
    });
    expect(r).toMatchObject({ channelRows: 6, kicked: false, failed: [] });
    expect(c.h.pushJobs.jobs.size).toBe(0);
    expect(c.h.pushStore.objects.size).toBe(0);

    const d = await setup();
    for (let i = 0; i < 5; i++) await submit(d, csvOf(0, 1));
    d.h.clock.tick(PUSH_JOB_MAX_AGE_SEC + 1);
    const broken = {
      ...d.h.pushJobs,
      listStaleUploads: async () => {
        throw new Error("db down");
      },
    };
    const out = await runPushJobSweep({
      jobs: broken,
      store: d.h.pushStore.store,
      invoke: async () => {
        throw new Error("no lambda");
      },
      clock: d.h.clock,
      logger: d.log.logger,
      batch: 2,
      maxBatches: 2,
    });
    // Four of five expired in two statements of two; the last one is still
    // runnable, so the kick is tried and its failure is a phase of its own.
    expect(out).toMatchObject({
      expired: 4,
      truncated: true,
      kicked: false,
      failed: ["uploads", "kick"],
    });
    expect(d.log.text()).toContain("push job sweep phase failed");
    expect(d.log.text()).toContain("push job sweep truncated");

    // Uploads: a full last page is reported as truncated.
    const e = await setup();
    for (let i = 0; i < 5; i++) await upload(e, csvOf(0, 1));
    e.h.clock.tick(PUSH_UPLOAD_RETAIN_SEC + 1);
    const paged = await runPushJobSweep({
      jobs: e.h.pushJobs,
      clock: e.h.clock,
      logger: e.log.logger,
      batch: 2,
      maxBatches: 2,
    });
    expect(paged).toMatchObject({ uploads: 4, truncated: true });
  });

  it("the digest names yesterday's failed jobs per channel, and a failed sweep phase", async () => {
    const c = await setup();
    await putToken(c, 0);
    const ok = await submit(c, csvOf(0, 1));
    const bad = await submit(c, "userId,name\n");
    const dry = await submit(c, "userId,name\n", { dryRun: true });
    await worker(c);
    expect(c.h.pushJobs.jobs.get(ok)?.status).toBe("done");
    expect(c.h.pushJobs.jobs.get(bad)?.status).toBe("failed");
    expect(c.h.pushJobs.jobs.get(dry)?.status).toBe("failed");
    c.h.clock.tick(86_400);
    const mails: string[] = [];
    const result = await runUsageDigest({
      stage: "dev",
      kv: c.h.kv,
      push: {
        db: c.h.push,
        jobs: c.h.pushJobs,
        jobSweep: {
          channelRows: 0,
          uploads: 0,
          expired: 0,
          swept: 0,
          stale: 0,
          kicked: false,
          truncated: false,
          failed: ["uploads"],
        },
      },
      notify: async (_subject, message) => {
        mails.push(message);
      },
      clock: c.h.clock,
      logger: c.log.logger,
    });
    expect(result.push?.jobs).toEqual([
      { channelId: c.id, jobs: 2, failed: 1 },
    ]);
    const kinds = result.warnings.map((w) => w.kind);
    expect(kinds).toContain(`push:jobs:failed:${c.id}:${DAY}`);
    expect(kinds).toContain("push:jobs:sweep:failed:uploads");
    expect(mails.join("\n")).toContain("1 of 2 campaign job(s) failed");
    // Without the jobs repository the line is simply absent.
    const plain = await runUsageDigest({
      stage: "dev",
      kv: c.h.kv,
      push: { db: c.h.push },
      clock: c.h.clock,
      logger: c.log.logger,
    });
    expect(plain.push?.jobs).toBeUndefined();
  });

  it("keeps a report part the cursor does not cover out of the report", async () => {
    const c = await setup();
    for (let n = 0; n < 20; n++) await putToken(c, n);
    const jobId = await submit(c, csvOf(0, 20));
    let batches = 0;
    const jobs = {
      ...c.h.pushJobs,
      advanceJob: async (
        ...args: Parameters<typeof c.h.pushJobs.advanceJob>
      ) => {
        if (++batches === 2) {
          // The second batch's part is written; the cancel lands, and this
          // run dies before the cursor write.
          await c.h.pushJobs.requestCancel(c.id, jobId, NOW_SEC);
          throw new Error("container killed");
        }
        return c.h.pushJobs.advanceJob(...args);
      },
      releaseJob: async () => false,
    };
    await expect(worker(c, { jobs, batchSize: 10 })).rejects.toThrow();
    expect(c.h.pushStore.objects.has(pushReportPartKey(c.id, jobId, 1))).toBe(
      true,
    );
    c.h.clock.tick(301);
    await worker(c, { batchSize: 10 });
    expect(await jobOf(c, jobId)).toMatchObject({
      status: "failed",
      error: "canceled",
      processed: 10,
    });
    // Ten rows, as the counters say; the orphan part is dropped with the rest.
    expect(reportOf(c, jobId)?.trim().split("\n")).toHaveLength(11);
    expect(
      await c.h.pushStore.store.list(pushReportPartsPrefix(c.id, jobId), 10),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Ending a job, held leases, turns                                    */
/* ------------------------------------------------------------------ */

describe("push campaign worker: endings and recovery", () => {
  const partsOf = (c: Ctx, jobId: string) =>
    [...c.h.pushStore.objects.keys()].filter((k) =>
      k.startsWith(pushReportPartsPrefix(c.id, jobId)),
    );
  /** A worker's sleep that really passes time. */
  const sleeper = (c: Ctx, slept: number[] = []) => ({
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
      c.h.clock.tick(ms / 1000);
    },
  });

  it("keeps the report when the row write fails after the report was assembled", async () => {
    const c = await setup();
    const jobId = await submit(c, csvOf(0, 30), { dryRun: true });
    let failed = false;
    const flaky = {
      ...c.h.pushJobs,
      finishJob: async (...args: Parameters<typeof c.h.pushJobs.finishJob>) => {
        if (!failed) {
          failed = true;
          throw new Error("db blip");
        }
        return c.h.pushJobs.finishJob(...args);
      },
    };
    await expect(worker(c, { jobs: flaky, batchSize: 10 })).rejects.toThrow(
      "db blip",
    );
    // The object was written, the row was not ended: the parts stay.
    expect(reportOf(c, jobId)?.trim().split("\n")).toHaveLength(31);
    expect(partsOf(c, jobId)).toHaveLength(3);
    expect(c.h.pushJobs.jobs.get(jobId)).toMatchObject({
      status: "running",
      cursor: 30,
      reportAt: null,
    });

    c.h.clock.tick(PUSH_JOB_RETRY_DELAY_SEC);
    const reads = c.h.pushStore.calls.readUpload;
    expect(await worker(c, { batchSize: 10 })).toEqual({
      claimed: 1,
      more: false,
    });
    // Ended without reading the file again, with the report it had.
    expect(c.h.pushStore.calls.readUpload).toBe(reads);
    const job = await jobOf(c, jobId);
    expect(job).toMatchObject({ status: "done", processed: 30 });
    expect(job.report).toMatchObject({ available: true });
    expect(reportOf(c, jobId)?.trim().split("\n")).toHaveLength(31);
    expect(partsOf(c, jobId)).toHaveLength(0);
    expect((await member(c, "GET", `/jobs/${jobId}/report`)).statusCode).toBe(
      200,
    );
  });

  it("ends with report_at when the parts are gone and the report object exists", async () => {
    const c = await setup();
    const jobId = await submit(c, csvOf(0, 30), { dryRun: true });
    let failed = false;
    const flaky = {
      ...c.h.pushJobs,
      finishJob: async (...args: Parameters<typeof c.h.pushJobs.finishJob>) => {
        if (!failed) {
          failed = true;
          throw new Error("db blip");
        }
        return c.h.pushJobs.finishJob(...args);
      },
    };
    await expect(worker(c, { jobs: flaky, batchSize: 10 })).rejects.toThrow();
    for (const k of partsOf(c, jobId)) c.h.pushStore.objects.delete(k);
    c.h.clock.tick(PUSH_JOB_RETRY_DELAY_SEC);
    await worker(c, { batchSize: 10 });
    const job = await jobOf(c, jobId);
    expect(job).toMatchObject({ status: "done" });
    expect(job.report).toMatchObject({ available: true });
    expect(reportOf(c, jobId)?.trim().split("\n")).toHaveLength(31);
  });

  it("a job is done even when its report parts cannot be removed", async () => {
    const c = await setup();
    const jobId = await submit(c, csvOf(0, 3), { dryRun: true });
    c.h.pushStore.failNext.op = "remove";
    expect(await worker(c)).toEqual({ claimed: 1, more: false });
    const job = await jobOf(c, jobId);
    expect(job).toMatchObject({ status: "done" });
    expect(job.report).toMatchObject({ available: true });
    expect(partsOf(c, jobId)).toHaveLength(1);
    expect(c.log.text()).toContain("push job report parts left");
  });

  it("a worker that lost its lease removes no part and writes no report", async () => {
    const c = await setup();
    const jobId = await submit(c, csvOf(0, 30), { dryRun: true });
    let calls = 0;
    const channels = {
      findPushChannel: async (id: string) => {
        const ch = await c.h.db.findPushChannel(id);
        // 1 = the turn's start, 2 = before batch 0, 3 = before batch 1.
        if (++calls === 3) {
          // Another worker took the job and already redid batch 1.
          const row = c.h.pushJobs.jobs.get(jobId)!;
          row.leaseOwner = "w_b";
          row.cursor = 20;
          c.h.pushStore.objects.set(pushReportPartKey(c.id, jobId, 1), {
            body: Buffer.from("b-rows\n"),
            contentType: "text/csv",
          });
          // And this worker sees the channel as inactive: it wants to end
          // the job.
          return { ...ch!, disabled: true, expiresAt: 1 };
        }
        return ch;
      },
    };
    await worker(c, { channels, batchSize: 10, owner: "w_a" });
    expect(c.h.pushJobs.jobs.get(jobId)).toMatchObject({
      status: "running",
      leaseOwner: "w_b",
      cursor: 20,
      reportAt: null,
    });
    // Both parts are where the holder left them, and no object was joined.
    expect(partsOf(c, jobId)).toHaveLength(2);
    expect(c.h.pushStore.text(pushReportPartKey(c.id, jobId, 1))).toBe(
      "b-rows\n",
    );
    expect(reportOf(c, jobId)).toBeUndefined();
    expect(c.log.text()).toContain("push job lease lost");
  });

  it("waits for the lease of a job whose worker was killed, then finishes it", async () => {
    const c = await setup();
    for (let n = 0; n < 4; n++) await putToken(c, n);
    const jobId = await submit(c, csvOf(0, 4));
    // A worker claimed the job and was killed: the lease is all it left.
    const now = Math.floor(c.h.clock.now() / 1000);
    await c.h.pushJobs.claimJob({ owner: "w_dead", now, leaseSec: 300 });
    c.h.clock.tick(100);
    const { slept, sleep } = sleeper(c);
    const run = await worker(c, { sleep });
    expect(run).toEqual({ claimed: 1, more: false });
    // One sleep, to the second the lease ran out.
    expect(slept).toEqual([200_000]);
    expect(await jobOf(c, jobId)).toMatchObject({
      status: "done",
      counts: { sent: 4 },
    });
    expect(c.log.text()).toContain("push job lease expired");
    // The dead run was counted, and the batch that followed cleared it.
    expect(c.h.pushJobs.jobs.get(jobId)!.attempts).toBe(0);
  });

  it("bounds the waits of one invocation and keeps the chain open", async () => {
    const c = await setup();
    await submit(c, csvOf(0, 1));
    const now = Math.floor(c.h.clock.now() / 1000);
    await c.h.pushJobs.claimJob({ owner: "w_dead", now, leaseSec: 300 });
    // A sleep that passes no time: the worker must not spin on it.
    const slept: number[] = [];
    const idle = await worker(c, {
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(idle).toEqual({ claimed: 0, more: true });
    expect(slept).toEqual(Array(PUSH_JOB_MAX_WAITS).fill(300_000));

    // The time box is shorter than the lease: sleep to its end, hand over.
    const boxed = sleeper(c);
    expect(
      await worker(c, { sleep: boxed.sleep, invocationBudgetMs: 120_000 }),
    ).toEqual({ claimed: 0, more: true });
    expect(boxed.slept).toEqual([120_000]);
    // The next invocation outlives the lease.
    const next = sleeper(c);
    expect(await worker(c, { sleep: next.sleep })).toEqual({
      claimed: 1,
      more: false,
    });
    expect(next.slept).toEqual([180_000]);
    // Nothing unfinished: no wait at all.
    const none = sleeper(c);
    expect(await worker(c, { sleep: none.sleep })).toEqual({
      claimed: 0,
      more: false,
    });
    expect(none.slept).toEqual([]);
  });

  it("a channel with many queued jobs does not take turns ahead of another channel", async () => {
    const c = await setup();
    const second = await send(
      c.h,
      ev("POST", `/projects/${c.a.prjId}/channels`, {
        headers: c.a.cookie,
        body: {
          kind: "push",
          name: "other",
          config: { authChannelId: c.auth, packageName: "com.example.other" },
        },
      }),
    );
    expect(second.statusCode, second.body).toBe(201);
    const d: Ctx = { ...c, id: parse(second).id, key: parse(second).apiKey };
    // The first channel queues three jobs before the second queues one.
    for (let i = 0; i < 3; i++) await submit(c, csvOf(0, 2), { dryRun: true });
    await submit(d, csvOf(0, 2), { dryRun: true });
    const order: string[] = [];
    const jobs = {
      ...c.h.pushJobs,
      advanceJob: async (
        ...args: Parameters<typeof c.h.pushJobs.advanceJob>
      ) => {
        const row = c.h.pushJobs.jobs.get(args[0])!;
        order.push(row.channelId === c.id ? "a" : "b");
        // Each batch outlasts the slice: one batch per turn.
        c.h.clock.tick(61);
        return c.h.pushJobs.advanceJob(...args);
      },
    };
    await worker(c, { jobs, batchSize: 1, invocationBudgetMs: 3_600_000 });
    // The second channel's job gets every other turn until it is done.
    expect(order).toEqual(["a", "b", "a", "b", "a", "a", "a", "a"]);
  });

  it("skips a row whose value puts a control character where a template allows none", async () => {
    const c = await setup();
    const esc = String.fromCharCode(27);
    const csv =
      "userId,name,note\n" +
      `${user(1)},plain,fine\n` +
      `${user(2)},"es${esc}c",fine\n` +
      `${user(3)},"two\nlines",fine\n` +
      `${user(4)},"cr\rhere",fine\n` +
      `${user(5)},plain,"two\nlines\tand a tab"\n` +
      `${user(6)},plain,"cr\r\nlf"\n` +
      `${user(7)},plain,"es${esc}c"\n`;
    for (let n = 1; n <= 7; n++) await putToken(c, n);
    const jobId = await submit(c, csv, {
      template: {
        title: "Hi {{name}}",
        body: "Note: {{note}}",
        data: { note: "{{note}}" },
      },
    });
    await worker(c);
    const job = await jobOf(c, jobId);
    expect(job).toMatchObject({
      status: "done",
      total: 7,
      counts: { sent: 2, invalid: 5, skipped: 5 },
    });
    expect(reportOf(c, jobId)).toBe(
      "userId,status,reason\n" +
        `${user(1)},sent,\n` +
        `${user(2)},skipped,invalid-value\n` +
        `${user(3)},skipped,invalid-value\n` +
        `${user(4)},skipped,invalid-value\n` +
        // A line break and a tab are what a body and a data value may hold.
        `${user(5)},sent,\n` +
        `${user(6)},skipped,invalid-value\n` +
        `${user(7)},skipped,invalid-value\n`,
    );
    // Nothing with a control character left the platform.
    expect(c.h.fcm.google.sent).toHaveLength(2);
    expect(JSON.stringify(c.h.fcm.google.sent)).not.toMatch(/\\u001b|\\r/);
  });

  it("a cancel that arrives during the last batch leaves the job done", async () => {
    const c = await setup();
    for (let n = 0; n < 20; n++) await putToken(c, n);
    const jobId = await submit(c, csvOf(0, 20));
    let batches = 0;
    const jobs = {
      ...c.h.pushJobs,
      advanceJob: async (
        ...args: Parameters<typeof c.h.pushJobs.advanceJob>
      ) => {
        if (++batches === 2)
          expect(
            (await member(c, "POST", `/jobs/${jobId}/cancel`)).statusCode,
          ).toBe(200);
        return c.h.pushJobs.advanceJob(...args);
      },
    };
    await worker(c, { jobs, batchSize: 10 });
    const job = await jobOf(c, jobId);
    expect(job).toMatchObject({
      status: "done",
      error: null,
      cancelRequested: true,
      processed: 20,
      counts: { sent: 20 },
    });
    expect(reportOf(c, jobId)?.trim().split("\n")).toHaveLength(21);

    // The same when the worker died after that batch: the next run finds
    // every row processed and ends the job without reading a cancel into it.
    const again = await submit(c, csvOf(0, 10));
    let died = false;
    const dying = {
      ...c.h.pushJobs,
      finishJob: async (...args: Parameters<typeof c.h.pushJobs.finishJob>) => {
        if (!died) {
          died = true;
          throw new Error("killed");
        }
        return c.h.pushJobs.finishJob(...args);
      },
    };
    await expect(worker(c, { jobs: dying })).rejects.toThrow("killed");
    await member(c, "POST", `/jobs/${again}/cancel`);
    c.h.clock.tick(PUSH_JOB_RETRY_DELAY_SEC);
    await worker(c);
    expect(await jobOf(c, again)).toMatchObject({
      status: "done",
      error: null,
      processed: 10,
    });
  });

  it("a broadcast remembers the projects it sent to, not a place in a list", async () => {
    const c = await setup();
    const key = (project: string) =>
      send(
        c.h,
        ev("PUT", `/channels/${c.id}/sender-key`, {
          headers: c.a.cookie,
          body: { serviceAccount: c.h.fcm.google.serviceAccountJson(project) },
        }),
      );
    expect((await key(TEAM_PROJECT)).statusCode).toBeLessThan(300);
    const r = await member(c, "POST", "/broadcast", {
      title: "T",
      idempotencyKey: "b",
    });
    const jobId = parse(r).job.id;
    let calls = 0;
    const dying = {
      ...c.h.pushJobs,
      advanceJob: async (
        ...args: Parameters<typeof c.h.pushJobs.advanceJob>
      ) => {
        const out = await c.h.pushJobs.advanceJob(...args);
        if (++calls === 1) throw new Error("container killed");
        return out;
      },
      releaseJob: async () => false,
    };
    await expect(worker(c, { jobs: dying })).rejects.toThrow();
    expect(c.h.fcm.google.sent.map((m) => m.projectId)).toEqual([P1]);
    // The note names no project, and no reader sees it.
    const row = c.h.pushJobs.jobs.get(jobId)!;
    expect(row.errorDetail).toEqual({ sent: [expect.any(String)] });
    expect(JSON.stringify(row.errorDetail)).not.toContain("example");
    expect((await jobOf(c, jobId)).errorDetails).toBeNull();

    // The team's key now belongs to a project that sorts before the
    // platform's: an index into the list would name the platform again.
    const early = "example-a-project";
    expect(early < P1).toBe(true);
    expect((await key(early)).statusCode).toBeLessThan(300);
    c.h.clock.tick(301);
    await worker(c);
    expect(c.h.fcm.google.sent.map((m) => m.projectId)).toEqual([P1, early]);
    const job = await jobOf(c, jobId);
    expect(job).toMatchObject({
      status: "done",
      total: 2,
      processed: 2,
      counts: { sent: 2 },
      errorDetails: null,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Uploads, keys and refusals                                          */
/* ------------------------------------------------------------------ */

describe("push campaign routes: uploads, keys and refusals", () => {
  it("deletes an upload on both families, unless an unfinished job reads it", async () => {
    const c = await setup();
    const templateId = await makeTemplate(c);
    const uploadId = await upload(c, csvOf(0, 1));
    const submitted = await member(c, "POST", "/jobs", {
      templateId,
      uploadId,
      idempotencyKey: "k",
      dryRun: true,
    });
    expect(submitted.statusCode).toBe(202);
    const busy = await member(c, "DELETE", `/uploads/${uploadId}`);
    expect(busy.statusCode).toBe(409);
    expect(errorOf(busy).details).toEqual({ reason: "upload_in_use" });
    expect(c.h.pushJobs.uploads.has(uploadId)).toBe(true);
    await worker(c);
    // The apiKey family, and the id in another case.
    const gone = await api(c, "DELETE", `/uploads/${uploadId.toUpperCase()}`);
    expect(gone.statusCode, gone.body).toBe(204);
    expect(c.h.pushJobs.uploads.has(uploadId)).toBe(false);
    expect(c.h.pushStore.objects.has(pushUploadKey(c.id, uploadId))).toBe(
      false,
    );
    expect((await member(c, "DELETE", `/uploads/${uploadId}`)).statusCode).toBe(
      404,
    );
    expect(
      (await api(c, "DELETE", "/uploads/pu_x", undefined, "no")).statusCode,
    ).toBe(401);

    // The row goes even when the object cannot be removed.
    const left = await upload(c, csvOf(0, 1));
    c.h.pushStore.failNext.op = "remove";
    expect((await member(c, "DELETE", `/uploads/${left}`)).statusCode).toBe(
      204,
    );
    expect(c.h.pushJobs.uploads.has(left)).toBe(false);
    expect(c.log.text()).toContain("push upload object left");
  });

  it("an upload whose job finished no longer counts toward the pending cap", async () => {
    const c = await setup();
    const templateId = await makeTemplate(c);
    const first = await upload(c, csvOf(0, 1));
    for (let i = 1; i < PUSH_UPLOADS_PER_CHANNEL; i++)
      await upload(c, csvOf(0, 1));
    const over = () => member(c, "POST", "/uploads", { size: 10 });
    expect((await over()).statusCode).toBe(409);
    await member(c, "POST", "/jobs", {
      templateId,
      uploadId: first,
      idempotencyKey: "k",
      dryRun: true,
    });
    // Named by an unfinished job: still pending.
    expect((await over()).statusCode).toBe(409);
    await worker(c);
    expect((await over()).statusCode).toBe(201);
    expect((await over()).statusCode).toBe(409);
    // The finished job's upload can still be named again.
    expect(
      (
        await member(c, "POST", "/jobs", {
          templateId,
          uploadId: first,
          idempotencyKey: "k2",
          dryRun: true,
        })
      ).statusCode,
    ).toBe(202);
  });

  it("stores the upload id as the row spells it, whatever the request's case", async () => {
    const c = await setup();
    for (let n = 0; n < 2; n++) await putToken(c, n);
    const templateId = await makeTemplate(c);
    const uploadId = await upload(c, csvOf(0, 2));
    const body = {
      templateId: templateId.toUpperCase(),
      uploadId: uploadId.toUpperCase(),
      idempotencyKey: "shout",
    };
    const r = await member(c, "POST", "/jobs", body);
    expect(r.statusCode, r.body).toBe(202);
    expect(parse(r).job).toMatchObject({ uploadId, templateId });
    // The same submit in the other case is the same job.
    const replay = await member(c, "POST", "/jobs", {
      ...body,
      templateId,
      uploadId,
    });
    expect(replay.statusCode).toBe(200);
    expect(parse(replay)).toMatchObject({
      created: false,
      job: { id: parse(r).job.id },
    });
    // The worker finds the object under the stored spelling.
    await worker(c);
    expect(await jobOf(c, parse(r).job.id)).toMatchObject({
      status: "done",
      counts: { sent: 2 },
    });
  });

  it("finds the job an idempotency key holds, on both families", async () => {
    const c = await setup();
    const jobId = await submit(c, csvOf(0, 1), {
      dryRun: true,
      key: "Find-Me",
    });
    await submit(c, csvOf(0, 1), { dryRun: true, key: "other" });
    const find = (family: "member" | "api", idempotencyKey: string) =>
      send(
        c.h,
        ev(
          "GET",
          family === "member"
            ? `/channels/${c.id}/push/jobs`
            : `/push-api/${c.id}/jobs`,
          {
            headers:
              family === "member"
                ? c.a.cookie
                : { authorization: `Bearer ${c.key}` },
            query: { idempotencyKey },
          },
        ),
      );
    for (const family of ["member", "api"] as const) {
      const r = await find(family, "Find-Me");
      expect(r.statusCode, r.body).toBe(200);
      expect(parse(r).jobs.map((j: { id: string }) => j.id)).toEqual([jobId]);
      expect(parse(r).next).toBeNull();
      // As the unique index compares: without case.
      expect(parse(await find(family, "find-me")).jobs).toHaveLength(1);
      expect(parse(await find(family, "nobody"))).toEqual({
        jobs: [],
        next: null,
      });
      expect((await find(family, "no blank")).statusCode).toBe(400);
    }
  });

  it("names each 503 and 410 with a reason", async () => {
    const bare = await setup({ pushJobStore: undefined });
    const storage = await member(bare, "POST", "/uploads", { size: 10 });
    expect(storage.statusCode).toBe(503);
    expect(errorOf(storage)).toMatchObject({
      message: "push storage unavailable",
      details: { reason: "push_storage_unavailable" },
    });

    // The slot the channel was registered on is gone from the pool.
    const c = await setup();
    const templateId = await makeTemplate(c);
    const uploadId = await upload(c, csvOf(0, 1));
    const bySlot = c.h.fcm.pool.bySlot;
    c.h.fcm.pool.bySlot = async () => undefined;
    const sender = await member(c, "POST", "/broadcast", {
      title: "T",
      idempotencyKey: "b",
    });
    c.h.fcm.pool.bySlot = bySlot;
    expect(sender.statusCode, sender.body).toBe(503);
    expect(errorOf(sender)).toMatchObject({
      message: "push sender unavailable",
      details: { reason: "push_sender_unavailable" },
    });

    // The report, eight days on.
    const jobId = await submit(c, csvOf(0, 1), { dryRun: true });
    await worker(c);
    c.h.db.channels.get(c.id)!.expiresAt = NOW_SEC + 100 * 86_400;
    c.h.clock.tick(PUSH_REPORT_TTL_SEC + 1);
    // By the key: a session does not live that long.
    const report = await api(c, "GET", `/jobs/${jobId}/report`);
    expect(report.statusCode).toBe(410);
    expect(errorOf(report)).toMatchObject({
      message: "the report expired",
      details: { reason: "report_expired" },
    });

    // The channel, disabled.
    c.h.db.channels.get(c.id)!.disabledAt = Math.floor(c.h.clock.now() / 1000);
    for (const r of [
      await api(c, "POST", "/jobs", {
        templateId,
        uploadId,
        idempotencyKey: "late",
      }),
      await api(c, "GET", "/jobs"),
    ]) {
      expect(r.statusCode).toBe(410);
      expect(errorOf(r)).toMatchObject({
        message: "channel expired or disabled",
        details: { reason: "channel_inactive" },
      });
    }
  });

  it("a patch of one field does not undo a concurrent patch of another", async () => {
    const c = await setup();
    const templateId = await makeTemplate(c, { title: "T1", body: "B1" });
    // Between this request's read and its write, another one lands.
    const real = c.h.pushJobs.findTemplate;
    let raced = false;
    c.h.pushJobs.findTemplate = async (channelId, id) => {
      const row = await real(channelId, id);
      if (!raced) {
        raced = true;
        await c.h.pushJobs.updateTemplate(channelId, id, {
          body: "B2",
          by: "peer",
          at: NOW_SEC,
        });
      }
      return row;
    };
    const r = await member(c, "PATCH", `/templates/${templateId}`, {
      title: "T2",
    });
    c.h.pushJobs.findTemplate = real;
    expect(r.statusCode, r.body).toBe(200);
    expect(parse(r)).toMatchObject({ title: "T2", body: "B2" });

    // The merged message is what is checked: the title cannot be emptied
    // under a body that a concurrent patch just wrote.
    const blank = await makeTemplate(c, { title: "T", data: { k: "v" } }, "b");
    raced = false;
    c.h.pushJobs.findTemplate = async (channelId, id) => {
      const row = await real(channelId, id);
      if (!raced) {
        raced = true;
        await c.h.pushJobs.updateTemplate(channelId, id, {
          body: "B",
          by: "peer",
          at: NOW_SEC,
        });
      }
      return row;
    };
    const refused = await member(c, "PATCH", `/templates/${blank}`, {
      title: "",
    });
    c.h.pushJobs.findTemplate = real;
    expect(refused.statusCode).toBe(400);
    expect(errorOf(refused).message).toBe("a body needs a title");
    expect(c.h.pushJobs.templates.get(blank)).toMatchObject({
      title: "T",
      body: "B",
    });
  });

  it("the digest says so when jobs expired or sat runnable for an hour", async () => {
    const c = await setup();
    await submit(c, csvOf(0, 1), { dryRun: true });
    await submit(c, csvOf(0, 1), { dryRun: true });
    const sweep = () =>
      runPushJobSweep({
        jobs: c.h.pushJobs,
        store: c.h.pushStore.store,
        clock: c.h.clock,
        logger: c.log.logger,
      });
    const digest = async (jobSweep: Awaited<ReturnType<typeof sweep>>) => {
      const mails: string[] = [];
      const result = await runUsageDigest({
        stage: "dev",
        kv: c.h.kv,
        push: { db: c.h.push, jobs: c.h.pushJobs, jobSweep },
        notify: async (_subject, message) => {
          mails.push(message);
        },
        clock: c.h.clock,
        logger: c.log.logger,
      });
      return { kinds: result.warnings.map((w) => w.kind), mails };
    };
    // Fresh jobs are neither.
    expect((await digest(await sweep())).kinds).toEqual([]);
    // An hour without a worker.
    c.h.clock.tick(PUSH_JOB_STALE_SEC);
    const stale = await sweep();
    expect(stale).toMatchObject({ stale: 2, expired: 0 });
    const first = await digest(stale);
    expect(first.kinds).toEqual(["push:jobs:stale:2"]);
    expect(first.mails.join("\n")).toContain("runnable for over an hour");
    // The same day again: said once.
    expect((await digest(stale)).mails).toEqual([]);
    // Still true the next day: said again.
    c.h.clock.tick(86_400);
    expect((await digest(await sweep())).mails).toHaveLength(1);
    // Three days on the sweep fails them, and that is named too.
    c.h.clock.tick(PUSH_JOB_MAX_AGE_SEC);
    const expired = await sweep();
    expect(expired).toMatchObject({ stale: 0, expired: 2 });
    const last = await digest(expired);
    expect(last.kinds).toEqual(["push:jobs:expired:2"]);
    expect(last.mails.join("\n")).toContain("failed as expired");
  });
});
