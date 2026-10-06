import { describe, expect, it } from "vitest";
import { AppError, type ChannelKind } from "@yyt/core";
import {
  createMemoryPushJobsDb,
  PUSH_JOBS_BATCH_MAX,
  PUSH_TEMPLATES_PER_CHANNEL,
  PUSH_UPLOADS_PER_CHANNEL,
  type PushJobInput,
  type PushJobsDb,
  type PushTemplateInput,
} from "../src/pushJobs.js";

const NOW = 1_000_000;
const DAY = Math.floor(NOW / 86_400);
const CH = "push_1";
const CH2 = "push_2";
const HASH = "a".repeat(64);
const HASH2 = "b".repeat(64);

export interface PushJobsHarness {
  db: PushJobsDb;
  /**
   * A second repository on its own connection, for the races. The fake has
   * no connection, so there it is `db` again.
   */
  peer: PushJobsDb;
  /** A live channel row (kind `push` unless said otherwise). */
  seedChannel(id: string, kind?: ChannelKind): Promise<void>;
  /** The soft delete of `ConsoleDb.deleteChannel`. */
  deleteChannel(id: string): Promise<void>;
  /** The hard delete of `ConsoleDb.purgeChannels`, which cascades. */
  purgeChannel(id: string): Promise<void>;
}

const template = (
  id: string,
  name: string,
  o: Partial<PushTemplateInput> = {},
): PushTemplateInput => ({
  id,
  channelId: CH,
  name,
  title: "Hello {{name}}",
  body: "Body",
  data: { kind: "promo" },
  by: "m1",
  at: NOW,
  ...o,
});

const job = (
  id: string,
  key: string,
  o: Partial<PushJobInput> = {},
): PushJobInput => ({
  id,
  channelId: CH,
  kind: "campaign",
  dryRun: false,
  idempotencyKey: key,
  paramsHash: HASH,
  templateId: "pt_1",
  title: "Hello {{name}}",
  body: "",
  data: { k: "v" },
  options: { priority: "high" },
  uploadId: "pu_1",
  uploadEtag: '"etag"',
  day: DAY,
  author: "m1",
  at: NOW,
  ...o,
});

const broadcast = (id: string, key: string, o: Partial<PushJobInput> = {}) =>
  job(id, key, {
    kind: "broadcast",
    uploadId: null,
    uploadEtag: null,
    templateId: null,
    ...o,
  });

const rejects = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(AppError);
  expect((e as AppError).code).toBe(code);
};

export function pushJobsContract(
  make: () => PushJobsHarness | Promise<PushJobsHarness>,
) {
  const seeded = async () => {
    const h = await make();
    await h.seedChannel(CH);
    return h;
  };

  /* ---------------- templates ---------------- */

  describe("templates", () => {
    it("creates, reads, lists by name, updates and deletes", async () => {
      const { db } = await seeded();
      const a = await db.createTemplate(template("pt_b", "beta"));
      expect(a).toMatchObject({
        ok: true,
        row: {
          id: "pt_b",
          channelId: CH,
          name: "beta",
          title: "Hello {{name}}",
          body: "Body",
          data: { kind: "promo" },
          createdBy: "m1",
          updatedBy: "m1",
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
      await db.createTemplate(template("pt_a", "Alpha", { data: {} }));
      expect((await db.listTemplates(CH)).map((t) => t.name)).toEqual([
        "Alpha",
        "beta",
      ]);
      expect((await db.findTemplate(CH, "pt_a"))?.data).toEqual({});
      // Another channel's id never reads this channel's template.
      expect(await db.findTemplate(CH2, "pt_a")).toBeUndefined();

      const u = await db.updateTemplate(CH, "pt_a", {
        title: "New",
        data: { a: "b" },
        by: "m2",
        at: NOW + 5,
      });
      expect(u).toMatchObject({
        ok: true,
        row: {
          name: "Alpha",
          title: "New",
          body: "Body",
          data: { a: "b" },
          createdBy: "m1",
          updatedBy: "m2",
          createdAt: NOW,
          updatedAt: NOW + 5,
        },
      });
      // An identical write is still a hit, and a missing row is not.
      expect(
        await db.updateTemplate(CH, "pt_a", {
          title: "New",
          by: "m2",
          at: NOW + 5,
        }),
      ).toMatchObject({ ok: true });
      expect(
        await db.updateTemplate(CH, "pt_none", { by: "m2", at: NOW }),
      ).toBeUndefined();
      expect(
        await db.updateTemplate(CH2, "pt_a", { by: "m2", at: NOW }),
      ).toBeUndefined();

      expect(await db.deleteTemplate(CH2, "pt_a")).toBe(false);
      expect(await db.deleteTemplate(CH, "pt_a")).toBe(true);
      expect(await db.deleteTemplate(CH, "pt_a")).toBe(false);
      expect(await db.findTemplate(CH, "pt_a")).toBeUndefined();
    });

    it("keeps a name unique per channel, without case, on create and rename", async () => {
      const h = await seeded();
      await h.seedChannel(CH2);
      const { db } = h;
      await db.createTemplate(template("pt_1", "Promo"));
      expect(await db.createTemplate(template("pt_2", "promo"))).toEqual({
        ok: false,
        reason: "name_taken",
      });
      // Another channel may use the name.
      expect(
        await db.createTemplate(template("pt_3", "promo", { channelId: CH2 })),
      ).toMatchObject({ ok: true });
      await db.createTemplate(template("pt_4", "other"));
      expect(
        await db.updateTemplate(CH, "pt_4", {
          name: "PROMO",
          by: "m1",
          at: NOW,
        }),
      ).toEqual({ ok: false, reason: "name_taken" });
      // Renaming a template to its own name in another case is no collision.
      expect(
        await db.updateTemplate(CH, "pt_1", {
          name: "PROMO",
          by: "m1",
          at: NOW,
        }),
      ).toMatchObject({ ok: true, row: { name: "PROMO" } });
    });

    it(`holds at most ${PUSH_TEMPLATES_PER_CHANNEL} per channel`, async () => {
      const { db } = await seeded();
      for (let i = 0; i < PUSH_TEMPLATES_PER_CHANNEL; i++)
        expect(
          await db.createTemplate(template(`pt_${i}`, `t${i}`)),
        ).toMatchObject({ ok: true });
      expect(await db.createTemplate(template("pt_x", "extra"))).toEqual({
        ok: false,
        reason: "cap",
      });
      await db.deleteTemplate(CH, "pt_0");
      expect(await db.createTemplate(template("pt_x", "extra"))).toMatchObject({
        ok: true,
      });
    });

    it("refuses a channel that is missing, deleted or of another kind, and bad input", async () => {
      const h = await seeded();
      const { db } = h;
      await rejects(
        db.createTemplate(template("pt_1", "a", { channelId: "push_none" })),
        "not_found",
      );
      await h.seedChannel("auth_1", "auth");
      await rejects(
        db.createTemplate(template("pt_1", "a", { channelId: "auth_1" })),
        "not_found",
      );
      await h.deleteChannel(CH);
      await rejects(db.createTemplate(template("pt_1", "a")), "not_found");

      await h.seedChannel(CH2);
      const on2 = (o: Partial<PushTemplateInput>) =>
        db.createTemplate(template("pt_1", "a", { channelId: CH2, ...o }));
      await rejects(on2({ name: "has blank" }), "bad_request");
      await rejects(on2({ name: "" }), "bad_request");
      await rejects(on2({ id: "bad id" }), "bad_request");
      await rejects(on2({ title: "x".repeat(1025) }), "bad_request");
      await rejects(on2({ body: "x".repeat(4097) }), "bad_request");
      await rejects(
        on2({ data: { k: 1 as unknown as string } }),
        "bad_request",
      );
      await rejects(on2({ data: { k: "x".repeat(17_000) } }), "bad_request");
      await rejects(
        db.updateTemplate(CH2, "pt_1", { name: "a b", by: "m1", at: NOW }),
        "bad_request",
      );
    });

    it("loses its templates when the channel row is purged", async () => {
      const h = await seeded();
      await h.db.createTemplate(template("pt_1", "a"));
      await h.purgeChannel(CH);
      expect(await h.db.listTemplates(CH)).toEqual([]);
    });
  });

  /* ---------------- uploads ---------------- */

  describe("uploads", () => {
    const upload = (id: string, at = NOW, channelId = CH) => ({
      id,
      channelId,
      size: 123,
      createdBy: "apikey",
      createdAt: at,
    });

    it("records an upload and reads it back for its own channel only", async () => {
      const { db } = await seeded();
      expect(await db.createUpload(upload("pu_1"))).toBe(true);
      expect(await db.findUpload(CH, "pu_1")).toEqual(upload("pu_1"));
      expect(await db.findUpload(CH2, "pu_1")).toBeUndefined();
      expect(await db.findUpload(CH, "pu_none")).toBeUndefined();
      await rejects(
        db.createUpload({ ...upload("pu_2"), size: 0 }),
        "bad_request",
      );
      await rejects(
        db.createUpload(upload("pu_2", NOW, "push_none")),
        "not_found",
      );
    });

    it(`holds at most ${PUSH_UPLOADS_PER_CHANNEL} rows per channel`, async () => {
      const { db } = await seeded();
      for (let i = 0; i < PUSH_UPLOADS_PER_CHANNEL; i++)
        expect(await db.createUpload(upload(`pu_${i}`))).toBe(true);
      expect(await db.createUpload(upload("pu_x"))).toBe(false);
      expect(await db.deleteUploads(["pu_0", "pu_none"])).toBe(1);
      expect(await db.createUpload(upload("pu_x"))).toBe(true);
    });

    it("lists stale uploads oldest first, in pages, without the ones an unfinished job reads", async () => {
      const { db } = await seeded();
      for (const [id, at] of [
        ["pu_c", 30],
        ["pu_a", 10],
        ["pu_b", 10],
        ["pu_d", 40],
        ["pu_new", 100],
      ] as const)
        await db.createUpload(upload(id, at));
      // `pu_b` is read by a queued job, `pu_c` by a finished one.
      await db.submitJob(job("pj_1", "k1", { uploadId: "pu_b" }), 10);
      await db.submitJob(job("pj_2", "k2", { uploadId: "pu_c" }), 10);
      const c = await db.claimJob({ owner: "w", now: NOW, leaseSec: 60 });
      expect(c?.job.id).toBe("pj_1");
      const c2 = await db.claimJob({ owner: "w", now: NOW, leaseSec: 60 });
      await db.finishJob(c2!.job.id, "w", { status: "done", at: NOW });

      const ids = async (...args: Parameters<PushJobsDb["listStaleUploads"]>) =>
        (await db.listStaleUploads(...args)).map((u) => u.id);
      expect(await ids(100, 10)).toEqual(["pu_a", "pu_c", "pu_d"]);
      // A page is cut before the busy rows are left out.
      expect(await ids(100, 2)).toEqual(["pu_a"]);
      expect(await ids(100, 2, { id: "pu_b", createdAt: 10 })).toEqual([
        "pu_c",
        "pu_d",
      ]);
      expect(await ids(100, 2, { id: "pu_d", createdAt: 40 })).toEqual([]);
      expect(await ids(10, 10)).toEqual([]);
      await rejects(db.listStaleUploads(100, 0), "bad_request");
      await rejects(
        db.listStaleUploads(100, PUSH_JOBS_BATCH_MAX + 1),
        "bad_request",
      );
    });

    it("drains a channel's uploads in bounded batches", async () => {
      const h = await seeded();
      await h.seedChannel(CH2);
      const { db } = h;
      for (let i = 0; i < 3; i++) await db.createUpload(upload(`pu_${i}`));
      await db.createUpload(upload("pu_other", NOW, CH2));
      expect(await db.deleteChannelUploads(CH, 2)).toBe(2);
      expect(await db.deleteChannelUploads(CH, 2)).toBe(1);
      expect(await db.deleteChannelUploads(CH, 2)).toBe(0);
      expect(await db.findUpload(CH2, "pu_other")).toBeDefined();
      expect(await db.deleteUploads([])).toBe(0);
    });
  });

  /* ---------------- submit ---------------- */

  describe("submitJob", () => {
    it("inserts a queued job with zeroed counters", async () => {
      const { db } = await seeded();
      const r = await db.submitJob(job("pj_1", "key-1"), 10);
      expect(r).toMatchObject({ ok: true, created: true });
      if (!r.ok) throw new Error("unreachable");
      expect(r.job).toEqual({
        id: "pj_1",
        channelId: CH,
        kind: "campaign",
        dryRun: false,
        idempotencyKey: "key-1",
        paramsHash: HASH,
        templateId: "pt_1",
        title: "Hello {{name}}",
        body: "",
        data: { k: "v" },
        options: { priority: "high" },
        uploadId: "pu_1",
        uploadEtag: '"etag"',
        day: DAY,
        status: "queued",
        error: null,
        errorDetail: null,
        cancelRequested: false,
        total: null,
        cursor: 0,
        resolved: 0,
        sent: 0,
        noToken: 0,
        unregistered: 0,
        failed: 0,
        duplicates: 0,
        missing: 0,
        invalid: 0,
        attempts: 0,
        leaseOwner: null,
        leaseUntil: 0,
        author: "m1",
        createdAt: NOW,
        startedAt: null,
        finishedAt: null,
        reportAt: null,
        updatedAt: NOW,
      });
      expect(await db.findJob(CH, "pj_1")).toEqual(r.job);
      expect(await db.findJob(CH2, "pj_1")).toBeUndefined();
      expect(await db.findJobByKey(CH, "key-1")).toEqual(r.job);
      expect(await db.findJobByKey(CH, "key-2")).toBeUndefined();
      expect(await db.findJobByKey(CH2, "key-1")).toBeUndefined();
    });

    it("answers a repeated key with the first job, or says the parameters differ", async () => {
      const h = await seeded();
      await h.seedChannel(CH2);
      const { db } = h;
      await db.submitJob(job("pj_1", "key-1"), 10);
      const again = await db.submitJob(job("pj_2", "key-1"), 10);
      expect(again).toMatchObject({
        ok: true,
        created: false,
        job: { id: "pj_1" },
      });
      // The key is compared without case (the column's collation).
      expect(await db.submitJob(job("pj_2", "KEY-1"), 10)).toMatchObject({
        ok: true,
        created: false,
        job: { id: "pj_1" },
      });
      expect(
        await db.submitJob(job("pj_2", "key-1", { paramsHash: HASH2 }), 10),
      ).toEqual({ ok: false, reason: "params_differ" });
      expect(await db.findJob(CH, "pj_2")).toBeUndefined();
      // The key is the channel's own: another channel may use it.
      expect(
        await db.submitJob(job("pj_3", "key-1", { channelId: CH2 }), 10),
      ).toMatchObject({ ok: true, created: true });
    });

    it("counts a channel's jobs of one UTC day against the limit, dry runs apart", async () => {
      const h = await seeded();
      await h.seedChannel(CH2);
      const { db } = h;
      expect(await db.submitJob(job("pj_1", "k1"), 2)).toMatchObject({
        ok: true,
      });
      expect(await db.submitJob(broadcast("pj_2", "k2"), 2)).toMatchObject({
        ok: true,
      });
      expect(await db.submitJob(job("pj_3", "k3"), 2)).toEqual({
        ok: false,
        reason: "day_cap",
        usage: 2,
        limit: 2,
      });
      expect(await db.countJobsOfDay(CH, DAY)).toBe(2);
      // A dry run is counted among dry runs only.
      expect(
        await db.submitJob(job("pj_4", "k4", { dryRun: true }), 1),
      ).toMatchObject({ ok: true });
      expect(
        await db.submitJob(job("pj_5", "k5", { dryRun: true }), 1),
      ).toEqual({ ok: false, reason: "day_cap", usage: 1, limit: 1 });
      expect(await db.countJobsOfDay(CH, DAY)).toBe(2);
      // Another day and another channel start at zero.
      expect(
        await db.submitJob(job("pj_6", "k6", { day: DAY + 1 }), 2),
      ).toMatchObject({ ok: true });
      expect(
        await db.submitJob(job("pj_7", "k7", { channelId: CH2 }), 2),
      ).toMatchObject({ ok: true });
      // A replay is answered before the cap.
      expect(await db.submitJob(job("pj_8", "k1"), 2)).toMatchObject({
        ok: true,
        created: false,
        job: { id: "pj_1" },
      });
      expect(await db.submitJob(job("pj_9", "k9"), 0)).toMatchObject({
        ok: false,
        reason: "day_cap",
      });
    });

    it("refuses a dead or foreign channel and malformed input", async () => {
      const h = await seeded();
      const { db } = h;
      await rejects(
        db.submitJob(job("pj_1", "k", { channelId: "push_none" }), 10),
        "not_found",
      );
      await h.seedChannel("auth_1", "auth");
      await rejects(
        db.submitJob(job("pj_1", "k", { channelId: "auth_1" }), 10),
        "not_found",
      );
      for (const bad of [
        { idempotencyKey: "" },
        { idempotencyKey: "has blank" },
        { idempotencyKey: "x".repeat(65) },
        { paramsHash: "nope" },
        { uploadId: null },
        { kind: "other" as "campaign" },
        { uploadEtag: "e".repeat(129) },
        { day: -1 },
        { id: "bad id" },
        { title: "x".repeat(1025) },
      ])
        await rejects(db.submitJob(job("pj_1", "k", bad), 10), "bad_request");
      await rejects(
        db.submitJob(broadcast("pj_1", "k", { uploadId: "pu_1" }), 10),
        "bad_request",
      );
      await rejects(
        db.submitJob(broadcast("pj_1", "k", { dryRun: true }), 10),
        "bad_request",
      );
      await rejects(db.submitJob(job("pj_1", "k"), -1), "bad_request");
      await h.deleteChannel(CH);
      await rejects(db.submitJob(job("pj_1", "k"), 10), "not_found");
    });

    it("lets one of two racing submits of one key create the job", async () => {
      const h = await seeded();
      const results = await Promise.all(
        [h.db, h.peer, h.db, h.peer].map((db, i) =>
          db.submitJob(job(`pj_r${i}`, "race"), 10),
        ),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
      const ids = new Set(results.map((r) => (r.ok ? r.job.id : "")));
      expect(ids.size).toBe(1);
      expect(await h.db.countJobsOfDay(CH, DAY)).toBe(1);
    });

    it("never lets racing submits pass the daily limit", async () => {
      const h = await seeded();
      await h.db.submitJob(job("pj_0", "k0"), 3);
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          (i % 2 ? h.peer : h.db).submitJob(job(`pj_c${i}`, `cap-${i}`), 3),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(2);
      for (const r of results)
        if (!r.ok) expect(r).toMatchObject({ reason: "day_cap", limit: 3 });
      expect(await h.db.countJobsOfDay(CH, DAY)).toBe(3);
    });
  });

  /* ---------------- reading ---------------- */

  describe("listing and cancelling", () => {
    it("lists a channel's jobs newest first, in pages", async () => {
      const h = await seeded();
      await h.seedChannel(CH2);
      const { db } = h;
      await db.submitJob(job("pj_a", "a", { at: 10 }), 99);
      await db.submitJob(job("pj_b", "b", { at: 20 }), 99);
      await db.submitJob(job("pj_c", "c", { at: 20 }), 99);
      await db.submitJob(job("pj_d", "d", { at: 30 }), 99);
      await db.submitJob(job("pj_x", "x", { channelId: CH2, at: 40 }), 99);
      const ids = async (
        opts: Parameters<PushJobsDb["listJobs"]>[1],
      ): Promise<string[]> => (await db.listJobs(CH, opts)).map((j) => j.id);
      expect(await ids({ limit: 10 })).toEqual([
        "pj_d",
        "pj_c",
        "pj_b",
        "pj_a",
      ]);
      expect(await ids({ limit: 2 })).toEqual(["pj_d", "pj_c"]);
      expect(
        await ids({ limit: 2, before: { id: "pj_c", createdAt: 20 } }),
      ).toEqual(["pj_b", "pj_a"]);
      expect(
        await ids({ limit: 2, before: { id: "pj_a", createdAt: 10 } }),
      ).toEqual([]);
      await rejects(db.listJobs(CH, { limit: 0 }), "bad_request");
    });

    it("marks an unfinished job for cancelling and leaves a finished one alone", async () => {
      const { db } = await seeded();
      await db.submitJob(job("pj_1", "k1"), 10);
      await db.submitJob(job("pj_2", "k2"), 10);
      expect(await db.requestCancel(CH, "pj_none", NOW)).toBeUndefined();
      expect(await db.requestCancel(CH2, "pj_1", NOW)).toBeUndefined();
      expect(await db.requestCancel(CH, "pj_1", NOW + 1)).toMatchObject({
        id: "pj_1",
        status: "queued",
        cancelRequested: true,
        updatedAt: NOW + 1,
      });
      // Again: nothing changes, not even the timestamp.
      expect(await db.requestCancel(CH, "pj_1", NOW + 9)).toMatchObject({
        cancelRequested: true,
        updatedAt: NOW + 1,
      });
      const c = await db.claimJob({ owner: "w", now: NOW, leaseSec: 60 });
      await db.finishJob(c!.job.id, "w", { status: "done", at: NOW });
      const other = c!.job.id === "pj_1" ? "pj_2" : "pj_1";
      expect(await db.requestCancel(CH, c!.job.id, NOW + 2)).toMatchObject({
        status: "done",
        cancelRequested: c!.job.id === "pj_1",
      });
      expect(await db.findJob(CH, other)).toMatchObject({ status: "queued" });
    });
  });

  /* ---------------- the worker's half ---------------- */

  describe("lease", () => {
    it("claims the job whose lease ran out longest ago, one holder at a time", async () => {
      const { db } = await seeded();
      expect(
        await db.claimJob({ owner: "w1", now: NOW, leaseSec: 60 }),
      ).toBeUndefined();
      expect(await db.hasRunnableJob(NOW)).toBe(false);
      await db.submitJob(job("pj_2", "k2", { at: NOW + 1 }), 10);
      await db.submitJob(job("pj_1", "k1", { at: NOW }), 10);
      expect(await db.hasRunnableJob(NOW)).toBe(true);

      const a = await db.claimJob({ owner: "w1", now: NOW + 10, leaseSec: 60 });
      expect(a).toMatchObject({
        stalled: false,
        job: {
          id: "pj_1",
          leaseOwner: "w1",
          leaseUntil: NOW + 70,
          attempts: 0,
          status: "queued",
        },
      });
      const b = await db.claimJob({ owner: "w2", now: NOW + 10, leaseSec: 60 });
      expect(b?.job.id).toBe("pj_2");
      expect(
        await db.claimJob({ owner: "w3", now: NOW + 10, leaseSec: 60 }),
      ).toBeUndefined();
      expect(await db.hasRunnableJob(NOW + 10)).toBe(false);

      // Given back: runnable from `notBefore`, and the one released first
      // is claimed first.
      expect(
        await db.releaseJob("pj_2", "w2", {
          at: NOW + 20,
          notBefore: NOW + 20,
        }),
      ).toBe(true);
      expect(
        await db.releaseJob("pj_1", "w1", {
          at: NOW + 21,
          notBefore: NOW + 25,
        }),
      ).toBe(true);
      expect(await db.findJob(CH, "pj_1")).toMatchObject({
        leaseOwner: null,
        leaseUntil: NOW + 25,
      });
      const c = await db.claimJob({ owner: "w3", now: NOW + 22, leaseSec: 60 });
      expect(c).toMatchObject({ stalled: false, job: { id: "pj_2" } });
      expect(
        await db.claimJob({ owner: "w3", now: NOW + 22, leaseSec: 60 }),
      ).toBeUndefined();
      expect(
        (await db.claimJob({ owner: "w3", now: NOW + 25, leaseSec: 60 }))?.job
          .id,
      ).toBe("pj_1");
    });

    it("counts an attempt when a lease runs out unreleased, and on a failed release", async () => {
      const { db } = await seeded();
      await db.submitJob(job("pj_1", "k1"), 10);
      await db.claimJob({ owner: "w1", now: NOW, leaseSec: 60 });
      expect(
        await db.claimJob({ owner: "w2", now: NOW + 59, leaseSec: 60 }),
      ).toBeUndefined();
      const again = await db.claimJob({
        owner: "w2",
        now: NOW + 60,
        leaseSec: 60,
      });
      expect(again).toMatchObject({
        stalled: true,
        job: { leaseOwner: "w2", attempts: 1 },
      });
      // The first holder is fenced out of every write.
      expect(await db.startJob("pj_1", "w1", { total: 5, at: NOW })).toBe(
        false,
      );
      expect(
        await db.releaseJob("pj_1", "w1", { at: NOW, notBefore: NOW }),
      ).toBe(false);
      expect(
        await db.finishJob("pj_1", "w1", { status: "done", at: NOW }),
      ).toBe(false);
      expect(
        await db.releaseJob("pj_1", "w2", {
          at: NOW + 61,
          notBefore: NOW + 120,
          attempt: true,
        }),
      ).toBe(true);
      expect(await db.findJob(CH, "pj_1")).toMatchObject({
        attempts: 2,
        leaseOwner: null,
        leaseUntil: NOW + 120,
        status: "queued",
      });
    });

    it("gives two racing workers two different jobs", async () => {
      const h = await seeded();
      await h.db.submitJob(job("pj_1", "k1"), 10);
      await h.db.submitJob(job("pj_2", "k2"), 10);
      const claims = await Promise.all(
        [h.db, h.peer, h.db, h.peer].map((db, i) =>
          db.claimJob({ owner: `w${i}`, now: NOW, leaseSec: 60 }),
        ),
      );
      const got = claims.flatMap((c) => (c ? [c.job.id] : []));
      expect(got.sort()).toEqual(["pj_1", "pj_2"]);
    });
  });

  describe("progress", () => {
    const claimed = async (db: PushJobsDb, owner = "w1") => {
      await db.submitJob(job("pj_1", "k1"), 10);
      await db.claimJob({ owner, now: NOW, leaseSec: 60 });
    };

    it("starts, advances with counts and finishes, fenced on owner, status and cursor", async () => {
      const { db } = await seeded();
      await claimed(db);
      // Not started: the cursor cannot move.
      expect(
        await db.advanceJob("pj_1", "w1", {
          from: 0,
          to: 2,
          add: {},
          now: NOW,
          leaseSec: 60,
        }),
      ).toBeUndefined();
      expect(await db.startJob("pj_1", "w1", { total: 5, at: NOW + 1 })).toBe(
        true,
      );
      // Again, e.g. after a lost answer: still true, the first time kept.
      expect(await db.startJob("pj_1", "w1", { total: 5, at: NOW + 2 })).toBe(
        true,
      );
      expect(await db.findJob(CH, "pj_1")).toMatchObject({
        status: "running",
        total: 5,
        startedAt: NOW + 1,
      });
      const a = await db.advanceJob("pj_1", "w1", {
        from: 0,
        to: 3,
        add: { resolved: 2, sent: 1, noToken: 1, failed: 1 },
        now: NOW + 5,
        leaseSec: 60,
      });
      expect(a).toMatchObject({
        cursor: 3,
        resolved: 2,
        sent: 1,
        noToken: 1,
        failed: 1,
        unregistered: 0,
        leaseUntil: NOW + 65,
        cancelRequested: false,
      });
      // The same batch again (a retry after a lost answer) changes nothing.
      expect(
        await db.advanceJob("pj_1", "w1", {
          from: 0,
          to: 3,
          add: { sent: 3 },
          now: NOW + 6,
          leaseSec: 60,
        }),
      ).toBeUndefined();
      // Nor does another owner's write.
      expect(
        await db.advanceJob("pj_1", "w2", {
          from: 3,
          to: 5,
          add: {},
          now: NOW + 6,
          leaseSec: 60,
        }),
      ).toBeUndefined();
      await db.requestCancel(CH, "pj_1", NOW + 6);
      const b = await db.advanceJob("pj_1", "w1", {
        from: 3,
        to: 5,
        add: { unregistered: 1, duplicates: 1, missing: 2, invalid: 3 },
        now: NOW + 7,
        leaseSec: 60,
      });
      expect(b).toMatchObject({
        cursor: 5,
        sent: 1,
        unregistered: 1,
        duplicates: 1,
        missing: 2,
        invalid: 3,
        cancelRequested: true,
      });
      expect(
        await db.finishJob("pj_1", "w1", {
          status: "failed",
          error: "canceled",
          errorDetail: { a: 1 },
          reportAt: NOW + 8,
          at: NOW + 8,
        }),
      ).toBe(true);
      expect(await db.findJob(CH, "pj_1")).toMatchObject({
        status: "failed",
        error: "canceled",
        errorDetail: { a: 1 },
        reportAt: NOW + 8,
        finishedAt: NOW + 8,
        leaseOwner: null,
        leaseUntil: 0,
      });
      // Finished: nothing moves it any more.
      expect(
        await db.finishJob("pj_1", "w1", { status: "done", at: NOW + 9 }),
      ).toBe(false);
      expect(
        await db.claimJob({ owner: "w9", now: NOW + 1000, leaseSec: 60 }),
      ).toBeUndefined();
    });

    it("refuses malformed progress", async () => {
      const { db } = await seeded();
      await claimed(db);
      await rejects(
        db.startJob("pj_1", "w1", { total: -1, at: NOW }),
        "bad_request",
      );
      const adv = (a: { from: number; to: number; add: object }) =>
        db.advanceJob("pj_1", "w1", { ...a, now: NOW, leaseSec: 60 });
      await rejects(adv({ from: 2, to: 2, add: {} }), "bad_request");
      await rejects(adv({ from: 0, to: 1, add: { sent: -1 } }), "bad_request");
      await rejects(adv({ from: 0, to: 1, add: { sent: 1.5 } }), "bad_request");
    });

    it("drops an error detail that does not fit rather than cutting it", async () => {
      const { db } = await seeded();
      await claimed(db);
      await db.finishJob("pj_1", "w1", {
        status: "failed",
        error: "csv_invalid",
        errorDetail: { reason: "x".repeat(300) },
        at: NOW,
      });
      expect(await db.findJob(CH, "pj_1")).toMatchObject({
        error: "csv_invalid",
        errorDetail: null,
        reportAt: null,
      });
    });
  });

  /* ---------------- sweeps ---------------- */

  describe("turns between channels", () => {
    it("serves the channel served least recently, however many jobs another one queued", async () => {
      const h = await seeded();
      await h.seedChannel(CH2);
      const { db } = h;
      // CH queues three jobs before CH2 queues one.
      for (const n of [1, 2, 3])
        await db.submitJob(job(`pj_a${n}`, `a${n}`, { at: NOW + n }), 10);
      await db.submitJob(
        job("pj_b1", "b1", { channelId: CH2, at: NOW + 9 }),
        10,
      );
      const turns: string[] = [];
      let at = NOW + 10;
      for (let i = 0; i < 6; i++) {
        const c = await db.claimJob({ owner: "w", now: at, leaseSec: 60 });
        turns.push(c!.job.id);
        at += 5;
        // A turn ends with the lease given back, as the worker's slice does.
        await db.releaseJob(c!.job.id, "w", { at, notBefore: at });
        at += 5;
      }
      // CH2's only job is second, not fourth, and keeps every other turn.
      expect(turns).toEqual([
        "pj_a1",
        "pj_b1",
        "pj_a2",
        "pj_b1",
        "pj_a3",
        "pj_b1",
      ]);
    });

    it("counts a finished job as a turn of its channel", async () => {
      const h = await seeded();
      await h.seedChannel(CH2);
      const { db } = h;
      await db.submitJob(job("pj_a1", "a1", { at: NOW }), 10);
      await db.claimJob({ owner: "w", now: NOW + 1, leaseSec: 60 });
      await db.finishJob("pj_a1", "w", { status: "done", at: NOW + 2 });
      // CH's next job is older than CH2's, but CH was just served.
      await db.submitJob(job("pj_a2", "a2", { at: NOW + 3 }), 10);
      await db.submitJob(
        job("pj_b1", "b1", { channelId: CH2, at: NOW + 4 }),
        10,
      );
      const c = await db.claimJob({ owner: "w", now: NOW + 5, leaseSec: 60 });
      expect(c?.job.id).toBe("pj_b1");
    });
  });

  describe("held leases", () => {
    it("names when the next held job becomes runnable", async () => {
      const { db } = await seeded();
      expect(await db.nextLeaseAt(NOW)).toBeUndefined();
      await db.submitJob(job("pj_1", "k1"), 10);
      await db.submitJob(job("pj_2", "k2", { at: NOW + 1 }), 10);
      // Runnable now is not "later".
      expect(await db.nextLeaseAt(NOW)).toBeUndefined();
      await db.claimJob({ owner: "w1", now: NOW, leaseSec: 300 });
      await db.claimJob({ owner: "w2", now: NOW, leaseSec: 60 });
      expect(await db.nextLeaseAt(NOW)).toBe(NOW + 60);
      expect(await db.nextLeaseAt(NOW + 60)).toBe(NOW + 300);
      expect(await db.nextLeaseAt(NOW + 300)).toBeUndefined();
      // A finished job holds nothing.
      await db.finishJob("pj_2", "w2", { status: "done", at: NOW + 1 });
      expect(await db.nextLeaseAt(NOW)).toBe(NOW + 300);
    });

    it("renews a lease for its holder only, and answers the row as it is", async () => {
      const { db } = await seeded();
      await db.submitJob(job("pj_1", "k1"), 10);
      await db.claimJob({ owner: "w1", now: NOW, leaseSec: 60 });
      await db.startJob("pj_1", "w1", { total: 5, at: NOW });
      await db.advanceJob("pj_1", "w1", {
        from: 0,
        to: 3,
        add: { sent: 3 },
        now: NOW,
        leaseSec: 60,
      });
      const held = await db.holdJob("pj_1", "w1", {
        now: NOW + 10,
        leaseSec: 60,
      });
      expect(held).toMatchObject({
        cursor: 3,
        leaseOwner: "w1",
        leaseUntil: NOW + 70,
      });
      // The same renewal again changes no row and still answers it.
      expect(
        await db.holdJob("pj_1", "w1", { now: NOW + 10, leaseSec: 60 }),
      ).toMatchObject({ leaseUntil: NOW + 70 });
      expect(
        await db.holdJob("pj_1", "w2", { now: NOW + 10, leaseSec: 60 }),
      ).toBeUndefined();
      await db.finishJob("pj_1", "w1", { status: "done", at: NOW + 11 });
      expect(
        await db.holdJob("pj_1", "w1", { now: NOW + 12, leaseSec: 60 }),
      ).toBeUndefined();
    });

    it("a batch that moves the cursor clears the failed runs and may leave a note", async () => {
      const { db } = await seeded();
      await db.submitJob(broadcast("pj_1", "k1"), 10);
      await db.claimJob({ owner: "w1", now: NOW, leaseSec: 60 });
      // The lease runs out: a dead run.
      const again = await db.claimJob({
        owner: "w2",
        now: NOW + 60,
        leaseSec: 60,
      });
      expect(again?.job.attempts).toBe(1);
      await db.startJob("pj_1", "w2", { total: 2, at: NOW + 60 });
      const after = await db.advanceJob("pj_1", "w2", {
        from: 0,
        to: 1,
        add: { sent: 1 },
        detail: { sent: ["abc"] },
        now: NOW + 61,
        leaseSec: 60,
      });
      expect(after).toMatchObject({
        attempts: 0,
        cursor: 1,
        errorDetail: { sent: ["abc"] },
      });
      // Without a note the previous one stays.
      expect(
        await db.advanceJob("pj_1", "w2", {
          from: 1,
          to: 2,
          add: { failed: 1 },
          now: NOW + 62,
          leaseSec: 60,
        }),
      ).toMatchObject({ errorDetail: { sent: ["abc"] } });
      // Ending the job replaces it.
      await db.finishJob("pj_1", "w2", { status: "done", at: NOW + 63 });
      expect((await db.findJob(CH, "pj_1"))?.errorDetail).toBeNull();
    });

    it("counts work that sat runnable past a cutoff, and clears a note when it expires a job", async () => {
      const { db } = await seeded();
      expect(await db.countStaleJobs(NOW)).toBe(0);
      await db.submitJob(job("pj_a", "k1", { at: NOW - 100 }), 10);
      await db.submitJob(broadcast("pj_b", "k2", { at: NOW - 90 }), 10);
      await db.submitJob(job("pj_c", "k3", { at: NOW - 80 }), 10);
      await db.submitJob(job("pj_new", "k4", { at: NOW + 50 }), 10);
      // Never claimed and old: stale. Submitted after the cutoff: not yet.
      expect(await db.countStaleJobs(NOW)).toBe(3);
      // A finished job and a held one are not waiting for a worker.
      const a = await db.claimJob({ owner: "w1", now: NOW, leaseSec: 60 });
      expect(a?.job.id).toBe("pj_a");
      await db.finishJob("pj_a", "w1", { status: "done", at: NOW });
      const b = await db.claimJob({ owner: "w2", now: NOW, leaseSec: 60 });
      expect(b?.job.id).toBe("pj_b");
      await db.startJob("pj_b", "w2", { total: 2, at: NOW });
      await db.advanceJob("pj_b", "w2", {
        from: 0,
        to: 1,
        add: { sent: 1 },
        detail: { sent: ["abc"] },
        now: NOW,
        leaseSec: 60,
      });
      expect(await db.countStaleJobs(NOW)).toBe(1);
      // Given back for later: stale only once it has been runnable since.
      await db.releaseJob("pj_b", "w2", { at: NOW, notBefore: NOW + 30 });
      expect(await db.countStaleJobs(NOW + 29)).toBe(1);
      expect(await db.countStaleJobs(NOW + 30)).toBe(2);
      expect(await db.countStaleJobs(NOW + 50)).toBe(3);
      expect(await db.expireJobs(NOW + 100, NOW + 100, 100)).toBe(3);
      expect(await db.findJob(CH, "pj_b")).toMatchObject({
        status: "failed",
        error: "expired",
        errorDetail: null,
      });
      expect(await db.countStaleJobs(NOW + 100)).toBe(0);
    });
  });

  describe("upload places and template patches", () => {
    const upload = (id: string) => ({
      id,
      channelId: CH,
      size: 123,
      createdBy: "m1",
      createdAt: NOW,
    });

    it("an upload whose jobs have all finished gives its place back", async () => {
      const { db } = await seeded();
      for (let i = 0; i < PUSH_UPLOADS_PER_CHANNEL; i++)
        expect(await db.createUpload(upload(`pu_${i}`))).toBe(true);
      expect(await db.createUpload(upload("pu_x"))).toBe(false);
      // A job names pu_0: still pending while the job is unfinished.
      await db.submitJob(job("pj_1", "k1", { uploadId: "pu_0" }), 10);
      await db.submitJob(job("pj_2", "k2", { uploadId: "pu_0" }), 10);
      expect(await db.createUpload(upload("pu_x"))).toBe(false);
      const c1 = await db.claimJob({ owner: "w", now: NOW, leaseSec: 60 });
      await db.finishJob(c1!.job.id, "w", { status: "done", at: NOW });
      // One of its two jobs is still unfinished.
      expect(await db.createUpload(upload("pu_x"))).toBe(false);
      const c2 = await db.claimJob({ owner: "w", now: NOW, leaseSec: 60 });
      await db.finishJob(c2!.job.id, "w", { status: "failed", at: NOW });
      expect(await db.createUpload(upload("pu_x"))).toBe(true);
      expect(await db.createUpload(upload("pu_y"))).toBe(false);
      // The row itself is still there for the age sweep.
      expect(await db.findUpload(CH, "pu_0")).toBeDefined();
    });

    it("deletes an upload of its channel unless an unfinished job reads it", async () => {
      const h = await seeded();
      await h.seedChannel(CH2);
      const { db } = h;
      await db.createUpload(upload("pu_1"));
      expect(await db.deleteUpload(CH, "pu_none")).toBeUndefined();
      expect(await db.deleteUpload(CH2, "pu_1")).toBeUndefined();
      await db.submitJob(job("pj_1", "k1", { uploadId: "pu_1" }), 10);
      expect(await db.deleteUpload(CH, "pu_1")).toBe("in_use");
      expect(await db.findUpload(CH, "pu_1")).toBeDefined();
      await db.claimJob({ owner: "w", now: NOW, leaseSec: 60 });
      await db.finishJob("pj_1", "w", { status: "done", at: NOW });
      // Named in another case: the stored spelling is answered.
      expect(await db.deleteUpload(CH, "PU_1")).toEqual(upload("pu_1"));
      expect(await db.findUpload(CH, "pu_1")).toBeUndefined();
      await rejects(db.deleteUpload("push_none", "pu_1"), "not_found");
    });

    it("a patch writes the fields it names and checks the merged message", async () => {
      const { db } = await seeded();
      await db.createTemplate(template("pt_1", "welcome"));
      // Two patches of different fields: neither undoes the other.
      await db.updateTemplate(CH, "pt_1", {
        title: "T2",
        by: "m2",
        at: NOW + 1,
      });
      const seen: unknown[] = [];
      const r = await db.updateTemplate(
        CH,
        "pt_1",
        { body: "B2", by: "m3", at: NOW + 2 },
        (next) => seen.push(next),
      );
      expect(r).toMatchObject({
        ok: true,
        row: {
          title: "T2",
          body: "B2",
          data: { kind: "promo" },
          updatedBy: "m3",
        },
      });
      // The check saw the stored title, not one the caller read earlier.
      expect(seen).toEqual([
        { title: "T2", body: "B2", data: { kind: "promo" } },
      ]);
      // A check that throws leaves the row as it was.
      await rejects(
        db.updateTemplate(
          CH,
          "pt_1",
          { title: "", by: "m4", at: NOW + 3 },
          () => {
            throw new AppError("bad_request", "a body needs a title");
          },
        ),
        "bad_request",
      );
      expect(await db.findTemplate(CH, "pt_1")).toMatchObject({
        title: "T2",
        updatedBy: "m3",
      });
      expect(
        await db.updateTemplate(CH, "pt_none", { by: "m", at: NOW }, () => {
          throw new Error("not reached");
        }),
      ).toBeUndefined();
    });

    it("two patches racing on different fields both land", async () => {
      const h = await seeded();
      await h.db.createTemplate(template("pt_1", "welcome"));
      await Promise.all([
        h.db.updateTemplate(CH, "pt_1", { title: "T2", by: "a", at: NOW + 1 }),
        h.peer.updateTemplate(CH, "pt_1", { body: "B2", by: "b", at: NOW + 1 }),
      ]);
      expect(await h.db.findTemplate(CH, "pt_1")).toMatchObject({
        title: "T2",
        body: "B2",
      });
    });
  });

  describe("sweeps", () => {
    it("expires unfinished jobs by age, whoever holds them", async () => {
      const { db } = await seeded();
      await db.submitJob(job("pj_old", "a", { at: 10 }), 99);
      await db.submitJob(job("pj_held", "b", { at: 20 }), 99);
      await db.submitJob(job("pj_new", "c", { at: 500 }), 99);
      await db.submitJob(job("pj_done", "d", { at: 5 }), 99);
      // Claim order: `pj_done` (oldest) first, then `pj_old`, then `pj_held`.
      const first = await db.claimJob({ owner: "w0", now: 600, leaseSec: 5 });
      await db.finishJob(first!.job.id, "w0", { status: "done", at: 600 });
      await db.claimJob({ owner: "w1", now: 600, leaseSec: 5 });
      const held = await db.claimJob({ owner: "w2", now: 600, leaseSec: 900 });
      expect(held?.job.id).toBe("pj_held");
      await db.startJob("pj_held", "w2", { total: 9, at: 600 });

      expect(await db.expireJobs(100, 700, 1)).toBe(1);
      expect(await db.expireJobs(100, 700, 10)).toBe(1);
      expect(await db.expireJobs(100, 700, 10)).toBe(0);
      for (const id of ["pj_old", "pj_held"])
        expect(await db.findJob(CH, id)).toMatchObject({
          status: "failed",
          error: "expired",
          finishedAt: 700,
          leaseOwner: null,
        });
      expect(await db.findJob(CH, "pj_new")).toMatchObject({
        status: "queued",
      });
      expect(await db.findJob(CH, "pj_done")).toMatchObject({
        status: "done",
        error: null,
      });
      // The holder's next write is fenced out.
      expect(
        await db.advanceJob("pj_held", "w2", {
          from: 0,
          to: 1,
          add: {},
          now: 701,
          leaseSec: 60,
        }),
      ).toBeUndefined();
    });

    it("sweeps finished jobs past a cutoff and drains a channel", async () => {
      const h = await seeded();
      await h.seedChannel(CH2);
      const { db } = h;
      for (const [id, at] of [
        ["pj_1", 100],
        ["pj_2", 200],
        ["pj_3", 300],
      ] as const) {
        await db.submitJob(job(id, id), 99);
        const c = await db.claimJob({ owner: "w", now: NOW, leaseSec: 60 });
        await db.finishJob(c!.job.id, "w", { status: "done", at });
      }
      await db.submitJob(job("pj_live", "live"), 99);
      await db.submitJob(job("pj_other", "o", { channelId: CH2 }), 99);
      expect(await db.sweepFinishedJobs(250, 1)).toBe(1);
      expect(await db.sweepFinishedJobs(250, 10)).toBe(1);
      expect(await db.sweepFinishedJobs(250, 10)).toBe(0);
      expect((await db.listJobs(CH, { limit: 10 })).length).toBe(2);
      // The key of a swept job is free again.
      expect(await db.submitJob(job("pj_n", "pj_1"), 99)).toMatchObject({
        ok: true,
        created: true,
      });
      expect(await db.deleteChannelJobs(CH, 2)).toBe(2);
      expect(await db.deleteChannelJobs(CH, 2)).toBe(1);
      expect(await db.deleteChannelJobs(CH, 2)).toBe(0);
      expect(await db.findJob(CH2, "pj_other")).toBeDefined();
      await rejects(db.deleteChannelJobs(CH, 0), "bad_request");
      await rejects(db.sweepFinishedJobs(1, 2.5), "bad_request");
      await rejects(
        db.expireJobs(1, 1, PUSH_JOBS_BATCH_MAX + 1),
        "bad_request",
      );
    });

    it("sums a day's jobs per channel, most failed first, dry runs left out", async () => {
      const h = await seeded();
      await h.seedChannel(CH2);
      await h.seedChannel("push_3");
      const { db } = h;
      const end = async (id: string, status: "done" | "failed") => {
        // Claims hand out jobs oldest first; find ours by finishing in order.
        const c = await db.claimJob({ owner: "w", now: NOW, leaseSec: 60 });
        expect(c?.job.id).toBe(id);
        await db.finishJob(id, "w", { status, at: NOW });
      };
      await db.submitJob(job("pj_1", "a", { at: 1 }), 99);
      await end("pj_1", "failed");
      await db.submitJob(job("pj_2", "b", { at: 2 }), 99);
      await end("pj_2", "done");
      await db.submitJob(job("pj_3", "c", { at: 3, channelId: CH2 }), 99);
      await end("pj_3", "failed");
      await db.submitJob(job("pj_4", "d", { at: 4, channelId: CH2 }), 99);
      await end("pj_4", "failed");
      await db.submitJob(job("pj_5", "e", { at: 5, channelId: "push_3" }), 99);
      await db.submitJob(
        job("pj_6", "f", { at: 6, channelId: "push_3", dryRun: true }),
        99,
      );
      await db.submitJob(job("pj_7", "g", { at: 7, day: DAY + 1 }), 99);
      expect(await db.jobStatsOfDay(DAY, 10)).toEqual([
        { channelId: CH2, jobs: 2, failed: 2 },
        { channelId: CH, jobs: 2, failed: 1 },
        { channelId: "push_3", jobs: 1, failed: 0 },
      ]);
      expect(await db.jobStatsOfDay(DAY, 1)).toEqual([
        { channelId: CH2, jobs: 2, failed: 2 },
      ]);
      expect(await db.jobStatsOfDay(DAY + 5, 10)).toEqual([]);
    });
  });
}

/** The memory fake as a harness: one repository, channels in a map. */
export function memoryPushJobsHarness(): PushJobsHarness {
  const channels = new Map<
    string,
    { kind: ChannelKind; deletedAt: number | null }
  >();
  const db = createMemoryPushJobsDb({ channel: (id) => channels.get(id) });
  return {
    db,
    peer: db,
    seedChannel: async (id, kind = "push") => {
      channels.set(id, { kind, deletedAt: null });
    },
    deleteChannel: async (id) => {
      const c = channels.get(id);
      if (c) c.deletedAt = NOW;
    },
    purgeChannel: async (id) => {
      channels.delete(id);
      db.channelsPurged([id]);
    },
  };
}

describe("memory push jobs db", () => {
  pushJobsContract(memoryPushJobsHarness);

  it("refuses every channel write without the channel hook", async () => {
    const db = createMemoryPushJobsDb();
    await rejects(db.createTemplate(template("pt_1", "a")), "not_found");
    await rejects(db.submitJob(job("pj_1", "k"), 1), "not_found");
  });

  it("refuses a duplicate id like the primary key does", async () => {
    const h = memoryPushJobsHarness();
    await h.seedChannel(CH);
    await h.db.submitJob(job("pj_1", "a"), 9);
    await rejects(h.db.submitJob(job("pj_1", "b"), 9), "conflict");
    await h.db.createTemplate(template("pt_1", "a"));
    await rejects(h.db.createTemplate(template("pt_1", "b")), "conflict");
    await h.db.createUpload({
      id: "pu_1",
      channelId: CH,
      size: 1,
      createdBy: "m1",
      createdAt: NOW,
    });
    await rejects(
      h.db.createUpload({
        id: "pu_1",
        channelId: CH,
        size: 1,
        createdBy: "m1",
        createdAt: NOW,
      }),
      "conflict",
    );
  });
});
