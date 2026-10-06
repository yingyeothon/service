import { AppError, type ChannelKind } from "@yyt/core";
import { cmpBin } from "./list.js";
import {
  isConflict,
  nul,
  num,
  run,
  type PrismaClient,
  type Tx,
} from "./prisma.js";
import { Prisma } from "./generated/prisma/client.js";

/*
 * Push campaigns (migration `m0029_push_campaigns`, docs/decisions.md *Push
 * notifications (Android, FCM)* #9). Three console-only tables:
 *
 *   - `push_templates`, the message templates of a push channel;
 *   - `push_uploads`, recipient CSVs a presigned PUT was issued for;
 *   - `push_jobs`, campaign, dry-run and broadcast jobs: the queue the
 *     console's `pushJob` worker drains, their progress and their result.
 *
 * A job row carries counts only. Recipients live in the uploaded object and
 * in the per-row report, both in S3; nothing here holds a device token.
 */

/** Templates one push channel holds (decisions #9); a code constant. */
export const PUSH_TEMPLATES_PER_CHANNEL = 20;
/**
 * Pending upload rows one push channel holds at a time; a code constant. An
 * upload stops counting once a job named it and every such job has finished.
 */
export const PUSH_UPLOADS_PER_CHANNEL = 20;
/** `push_jobs`.`author` / `push_uploads`.`created_by` of an apiKey caller. */
export const PUSH_AUTHOR_APIKEY = "apikey";

/** Held by the `push_jobs_kind` CHECK. */
export const PUSH_JOB_KINDS = ["campaign", "broadcast"] as const;
export type PushJobKind = (typeof PUSH_JOB_KINDS)[number];
/** Held by the `push_jobs_status` CHECK. */
export const PUSH_JOB_STATUSES = [
  "queued",
  "running",
  "done",
  "failed",
] as const;
export type PushJobStatus = (typeof PUSH_JOB_STATUSES)[number];
const UNFINISHED: PushJobStatus[] = ["queued", "running"];

/** A template name: ASCII, no blank, so the `_ci` index has nothing to fold. */
export const PUSH_TEMPLATE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * A caller's idempotency key. The column keeps the database default
 * collation, so two keys that differ only by case are one key.
 */
export const PUSH_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** Width of `title` / `body`; the payload limit is what really bounds both. */
export const PUSH_TEMPLATE_TITLE_MAX = 1024;
export const PUSH_TEMPLATE_BODY_MAX = 4096;
/** Characters of `data_json`: the 4096-byte payload cap leaves no room for more. */
export const PUSH_TEMPLATE_DATA_JSON_MAX = 16_384;
/** Rows one batched delete or one sweep page takes. */
export const PUSH_JOBS_BATCH_MAX = 2_000;
/** Width of `error_detail`. */
const ERROR_DETAIL_MAX = 255;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ETAG_MAX = 128;
const COUNT_MAX = 10_000_000;

const bad = (message: string) => new AppError("bad_request", message);
const channelGone = () => new AppError("not_found", "push channel not found");

function checkId(id: string, what: string): string {
  if (!ID.test(id)) throw bad(`invalid ${what}`);
  return id;
}

function checkBatch(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > PUSH_JOBS_BATCH_MAX)
    throw bad("invalid batch limit");
  return limit;
}

/** The message a template or a job carries; `data` values are strings. */
export interface PushMessageText {
  /** Empty for a data-only message. */
  title: string;
  body: string;
  data: Record<string, string>;
}

export interface PushTemplateRow extends PushMessageText {
  id: string;
  channelId: string;
  name: string;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface PushTemplateInput extends PushMessageText {
  id: string;
  channelId: string;
  name: string;
  by: string;
  at: number;
}

export type PushTemplatePatch = Partial<PushMessageText> & {
  name?: string;
  by: string;
  at: number;
};

export type PushTemplateWrite =
  | { ok: true; row: PushTemplateRow }
  /** Another template of the channel holds the name (case-insensitive). */
  | { ok: false; reason: "name_taken" }
  /** The channel holds {@link PUSH_TEMPLATES_PER_CHANNEL} already. */
  | { ok: false; reason: "cap" };

export interface PushUploadRow {
  id: string;
  channelId: string;
  /** The byte length signed into the upload URL. */
  size: number;
  createdBy: string;
  createdAt: number;
}

/** Delivery options a job's messages carry; all optional. */
export interface PushJobOptions {
  priority?: "high" | "normal";
  ttlSec?: number;
  collapseKey?: string;
}

/** Per-user (row) counts of a job; see the migration for each. */
export interface PushJobCounts {
  resolved: number;
  sent: number;
  noToken: number;
  unregistered: number;
  failed: number;
  duplicates: number;
  missing: number;
  invalid: number;
}

export const PUSH_JOB_COUNT_KEYS = [
  "resolved",
  "sent",
  "noToken",
  "unregistered",
  "failed",
  "duplicates",
  "missing",
  "invalid",
] as const satisfies readonly (keyof PushJobCounts)[];

export interface PushJobRow extends PushMessageText, PushJobCounts {
  id: string;
  channelId: string;
  kind: PushJobKind;
  dryRun: boolean;
  idempotencyKey: string;
  paramsHash: string;
  templateId: string | null;
  options: PushJobOptions;
  uploadId: string | null;
  uploadEtag: string | null;
  day: number;
  status: PushJobStatus;
  error: string | null;
  errorDetail: Record<string, unknown> | null;
  cancelRequested: boolean;
  /** Data rows of the CSV; null until the worker counted them. */
  total: number | null;
  /** Data rows fully processed. */
  cursor: number;
  attempts: number;
  leaseOwner: string | null;
  leaseUntil: number;
  author: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  reportAt: number | null;
  updatedAt: number;
}

export interface PushJobInput extends PushMessageText {
  id: string;
  channelId: string;
  kind: PushJobKind;
  dryRun: boolean;
  idempotencyKey: string;
  paramsHash: string;
  templateId: string | null;
  options: PushJobOptions;
  uploadId: string | null;
  uploadEtag: string | null;
  day: number;
  author: string;
  at: number;
}

export type PushJobSubmit =
  /** `created: false` is a replay: the job the key already named. */
  | { ok: true; created: boolean; job: PushJobRow }
  /** The key names a job submitted with other parameters. */
  | { ok: false; reason: "params_differ" }
  /** The channel's jobs of `day` reached `limit` (dry runs: their own cap). */
  | { ok: false; reason: "day_cap"; usage: number; limit: number };

export interface PushJobClaim {
  job: PushJobRow;
  /** The previous holder never released the lease: it died mid-run. */
  stalled: boolean;
}

/** One channel's jobs of a UTC day, for the daily digest. */
export interface PushJobDayStats {
  channelId: string;
  /** Jobs created that day, dry runs excluded. */
  jobs: number;
  /** Of those, how many ended `failed`. */
  failed: number;
}

export interface PushJobsDb {
  /**
   * Creates a template under the channel row's lock: the channel must be a
   * live push channel (`not_found` otherwise), hold fewer than
   * {@link PUSH_TEMPLATES_PER_CHANNEL} and no template of that name.
   */
  createTemplate(t: PushTemplateInput): Promise<PushTemplateWrite>;
  /** By name, case-insensitively. */
  listTemplates(channelId: string): Promise<PushTemplateRow[]>;
  findTemplate(
    channelId: string,
    id: string,
  ): Promise<PushTemplateRow | undefined>;
  /**
   * Writes the fields the patch names, under the template row's lock, so two
   * patches of different fields both land. `check` is handed the message as
   * it will be after the write (the stored fields under the lock, merged
   * with the patch); what it throws aborts the write. `undefined` when the
   * channel holds no such template.
   */
  updateTemplate(
    channelId: string,
    id: string,
    patch: PushTemplatePatch,
    check?: (next: PushMessageText) => void,
  ): Promise<PushTemplateWrite | undefined>;
  deleteTemplate(channelId: string, id: string): Promise<boolean>;

  /**
   * Records an upload under the channel row's lock; `false` when the channel
   * holds {@link PUSH_UPLOADS_PER_CHANNEL} pending uploads already. Pending:
   * no job names it yet, or an unfinished job does. `not_found` for a channel
   * that is not a live push channel.
   */
  createUpload(u: PushUploadRow): Promise<boolean>;
  /**
   * Removes one upload row under the channel row's lock (the lock a submit
   * takes): `in_use` while an unfinished job names it, `undefined` when the
   * channel holds no such upload. Answers the row it removed, for its object.
   */
  deleteUpload(
    channelId: string,
    id: string,
  ): Promise<PushUploadRow | "in_use" | undefined>;
  findUpload(channelId: string, id: string): Promise<PushUploadRow | undefined>;
  /**
   * Uploads created before `cutoff` that no unfinished job reads, oldest
   * first, at most `limit`; `after` continues past the previous page.
   */
  listStaleUploads(
    cutoff: number,
    limit: number,
    after?: Pick<PushUploadRow, "id" | "createdAt">,
  ): Promise<PushUploadRow[]>;
  deleteUploads(ids: readonly string[]): Promise<number>;
  /** A dying channel's upload rows, in one bounded batch. */
  deleteChannelUploads(channelId: string, limit: number): Promise<number>;

  /**
   * Submits a job in one transaction under the channel row's lock, so the
   * idempotency key and the daily cap are decided once whatever races:
   *
   *   1. the channel is a live push channel (`not_found` otherwise);
   *   2. a job of the channel already holds the key: the same `paramsHash`
   *      answers that job (`created: false`), another one `params_differ`;
   *   3. the channel's jobs of `day` with the same `dryRun` are counted
   *      against `limit` (`day_cap`);
   *   4. the row is inserted `queued`.
   *
   * A replay is answered before the cap, so retrying a submit never fails on
   * a day that filled up meanwhile.
   */
  submitJob(j: PushJobInput, limit: number): Promise<PushJobSubmit>;
  findJob(channelId: string, id: string): Promise<PushJobRow | undefined>;
  /** The job a channel's idempotency key names, if any. */
  findJobByKey(
    channelId: string,
    idempotencyKey: string,
  ): Promise<PushJobRow | undefined>;
  /** Newest first; `before` is the last row of the previous page. */
  listJobs(
    channelId: string,
    opts: { limit: number; before?: Pick<PushJobRow, "id" | "createdAt"> },
  ): Promise<PushJobRow[]>;
  /** The channel's jobs of `day`, dry runs excluded: `push.jobsPerDay` usage. */
  countJobsOfDay(channelId: string, day: number): Promise<number>;
  /**
   * Asks an unfinished job to stop; the worker ends it between two batches.
   * Returns the row as it is afterwards, `undefined` when there is none.
   */
  requestCancel(
    channelId: string,
    id: string,
    at: number,
  ): Promise<PushJobRow | undefined>;

  /**
   * Claims the next runnable job for `owner` until `now + leaseSec`.
   * Channels take turns: the channel served least recently goes first --
   * "served" is the latest `lease_until` or `finished_at` of any of its jobs
   * -- and inside it the job whose lease ran out longest ago (a job never
   * worked on first, oldest first). A channel with many queued jobs therefore
   * gets one turn between two turns of any other channel. `undefined` when
   * none is runnable. The claim is one conditional update on the lease it
   * read, so two workers never hold one job.
   */
  claimJob(c: {
    owner: string;
    now: number;
    leaseSec: number;
  }): Promise<PushJobClaim | undefined>;
  /** Whether any job is runnable at `now`. */
  hasRunnableJob(now: number): Promise<boolean>;
  /**
   * The earliest `lease_until` after `now` of an unfinished job: when a job
   * held by a dead worker (or waiting out a retry delay) becomes runnable.
   * `undefined` when there is none.
   */
  nextLeaseAt(now: number): Promise<number | undefined>;
  /**
   * Unfinished jobs that have been runnable since `cutoff` or longer
   * (`lease_until` and `created_at` both at or before it): work no worker
   * picked up.
   */
  countStaleJobs(cutoff: number): Promise<number>;
  /**
   * Extends the lease of a job `owner` holds and answers the row as it is
   * now; `undefined` when the fence failed. What a worker calls before a
   * step that must not run for a job it lost.
   */
  holdJob(
    id: string,
    owner: string,
    h: { now: number; leaseSec: number },
  ): Promise<PushJobRow | undefined>;
  /**
   * `queued` -> `running` with the row count. Fenced on the lease: `false`
   * when `owner` no longer holds the job.
   */
  startJob(
    id: string,
    owner: string,
    s: { total: number; at: number },
  ): Promise<boolean>;
  /**
   * Moves the cursor from `from` to `to`, adds the batch's counts, extends
   * the lease and resets `attempts` (progress was made), in one statement
   * fenced on the owner, the status and the cursor it expects. `detail`
   * replaces `error_detail`, which a running job may use as its own progress
   * note (a broadcast: the projects already sent to). Returns the row
   * afterwards, or `undefined` when the fence failed (the lease was lost, or
   * the job was ended): the caller stops.
   */
  advanceJob(
    id: string,
    owner: string,
    a: {
      from: number;
      to: number;
      add: Partial<PushJobCounts>;
      detail?: Record<string, unknown>;
      now: number;
      leaseSec: number;
    },
  ): Promise<PushJobRow | undefined>;
  /**
   * Gives the lease back; the job is runnable again from `notBefore`. With
   * `attempt` the release counts as a failed run (`attempts` + 1), like a
   * lease that ran out.
   */
  releaseJob(
    id: string,
    owner: string,
    r: { at: number; notBefore: number; attempt?: boolean },
  ): Promise<boolean>;
  /** Ends a job its `owner` holds. `false` when the fence failed. */
  finishJob(
    id: string,
    owner: string,
    f: {
      status: "done" | "failed";
      error?: string;
      errorDetail?: Record<string, unknown>;
      reportAt?: number;
      at: number;
    },
  ): Promise<boolean>;
  /**
   * Fails (`error` = `expired`) unfinished jobs created before `cutoff`,
   * whoever holds them, in one bounded batch: the backstop for a job no
   * worker can finish. `error_detail` is cleared with it.
   */
  expireJobs(cutoff: number, at: number, limit: number): Promise<number>;
  /** Finished jobs with `finished_at < cutoff`, globally, in one bounded batch. */
  sweepFinishedJobs(cutoff: number, limit: number): Promise<number>;
  /** A dying channel's jobs, in one bounded batch. */
  deleteChannelJobs(channelId: string, limit: number): Promise<number>;
  /**
   * Per channel, the jobs created on `day` (dry runs excluded): the `limit`
   * channels with the most failed jobs, then the most jobs.
   */
  jobStatsOfDay(day: number, limit: number): Promise<PushJobDayStats[]>;
}

/* --- shared guards (both implementations) --- */

function checkText(t: Partial<PushMessageText>): void {
  if (t.title !== undefined && t.title.length > PUSH_TEMPLATE_TITLE_MAX)
    throw bad("title is too long");
  if (t.body !== undefined && t.body.length > PUSH_TEMPLATE_BODY_MAX)
    throw bad("body is too long");
  if (t.data !== undefined) {
    for (const v of Object.values(t.data) as unknown[])
      if (typeof v !== "string") throw bad("data values must be strings");
    if (JSON.stringify(t.data).length > PUSH_TEMPLATE_DATA_JSON_MAX)
      throw bad("data is too large");
  }
}

function checkTemplateName(name: string): string {
  if (!PUSH_TEMPLATE_NAME.test(name)) throw bad("invalid template name");
  return name;
}

function checkTemplate(t: PushTemplateInput): void {
  checkId(t.id, "template id");
  checkTemplateName(t.name);
  checkText(t);
}

function checkPatch(p: PushTemplatePatch): void {
  if (p.name !== undefined) checkTemplateName(p.name);
  checkText(p);
}

function checkUpload(u: PushUploadRow): void {
  checkId(u.id, "upload id");
  if (!Number.isSafeInteger(u.size) || u.size < 1) throw bad("invalid size");
}

function checkJob(j: PushJobInput, limit: number): void {
  checkId(j.id, "job id");
  if (!(PUSH_JOB_KINDS as readonly string[]).includes(j.kind))
    throw bad("invalid kind");
  if (!PUSH_IDEMPOTENCY_KEY.test(j.idempotencyKey))
    throw bad("invalid idempotencyKey");
  if (!SHA256.test(j.paramsHash)) throw bad("invalid paramsHash");
  if ((j.kind === "campaign") !== (j.uploadId !== null))
    throw bad("a campaign names an upload and a broadcast names none");
  if (j.kind === "broadcast" && j.dryRun)
    throw bad("a broadcast has no dry run");
  if (j.uploadEtag !== null && j.uploadEtag.length > ETAG_MAX)
    throw bad("invalid uploadEtag");
  if (!Number.isInteger(j.day) || j.day < 0) throw bad("invalid day");
  if (!Number.isInteger(limit) || limit < 0) throw bad("invalid limit");
  checkText(j);
}

function checkAdd(add: Partial<PushJobCounts>): PushJobCounts {
  const out = {} as PushJobCounts;
  for (const k of PUSH_JOB_COUNT_KEYS) {
    const n = add[k] ?? 0;
    if (!Number.isInteger(n) || n < 0 || n > COUNT_MAX)
      throw bad("invalid count");
    out[k] = n;
  }
  return out;
}

function detailJson(d: Record<string, unknown> | undefined): string | null {
  if (d === undefined) return null;
  const s = JSON.stringify(d);
  // A detail that does not fit is dropped rather than cut into bad JSON.
  return s.length > ERROR_DETAIL_MAX ? null : s;
}

function parseObject<T>(json: string | null, fallback: T): T {
  if (json === null) return fallback;
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as T;
  } catch {
    // falls through
  }
  return fallback;
}

const ci = (s: string) => s.toLowerCase();

/** Most failed first, then most jobs, then the channel id. */
const sortDayStats = (rows: PushJobDayStats[]): PushJobDayStats[] =>
  rows.sort(
    (a, b) =>
      b.failed - a.failed ||
      b.jobs - a.jobs ||
      cmpBin(a.channelId, b.channelId),
  );

type TemplateModel = {
  id: string;
  channel_id: string;
  name: string;
  title: string;
  body: string;
  data_json: string;
  created_by: string;
  updated_by: string;
  created_at: bigint | number;
  updated_at: bigint | number;
};

const toTemplate = (r: TemplateModel): PushTemplateRow => ({
  id: r.id,
  channelId: r.channel_id,
  name: r.name,
  title: r.title,
  body: r.body,
  data: parseObject<Record<string, string>>(r.data_json, {}),
  createdBy: r.created_by,
  updatedBy: r.updated_by,
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const toUpload = (r: {
  id: string;
  channel_id: string;
  size: bigint | number;
  created_by: string;
  created_at: bigint | number;
}): PushUploadRow => ({
  id: r.id,
  channelId: r.channel_id,
  size: num(r.size),
  createdBy: r.created_by,
  createdAt: num(r.created_at),
});

type JobModel = {
  id: string;
  channel_id: string;
  kind: string;
  dry_run: boolean;
  idempotency_key: string;
  params_hash: string;
  template_id: string | null;
  title: string;
  body: string;
  data_json: string;
  options_json: string;
  upload_id: string | null;
  upload_etag: string | null;
  day: number;
  status: string;
  error: string | null;
  error_detail: string | null;
  cancel_requested: boolean;
  total: number | null;
  cursor_row: number;
  resolved: number;
  sent: number;
  no_token: number;
  unregistered: number;
  failed: number;
  duplicates: number;
  missing: number;
  invalid: number;
  attempts: number;
  lease_owner: string | null;
  lease_until: bigint | number;
  author: string;
  created_at: bigint | number;
  started_at: bigint | number | null;
  finished_at: bigint | number | null;
  report_at: bigint | number | null;
  updated_at: bigint | number;
};

const toJob = (r: JobModel): PushJobRow => ({
  id: r.id,
  channelId: r.channel_id,
  kind: r.kind as PushJobKind,
  dryRun: r.dry_run,
  idempotencyKey: r.idempotency_key,
  paramsHash: r.params_hash,
  templateId: r.template_id,
  title: r.title,
  body: r.body,
  data: parseObject<Record<string, string>>(r.data_json, {}),
  options: parseObject<PushJobOptions>(r.options_json, {}),
  uploadId: r.upload_id,
  uploadEtag: r.upload_etag,
  day: r.day,
  status: r.status as PushJobStatus,
  error: r.error,
  errorDetail: parseObject<Record<string, unknown> | null>(
    r.error_detail,
    null,
  ),
  cancelRequested: r.cancel_requested,
  total: r.total,
  cursor: r.cursor_row,
  resolved: r.resolved,
  sent: r.sent,
  noToken: r.no_token,
  unregistered: r.unregistered,
  failed: r.failed,
  duplicates: r.duplicates,
  missing: r.missing,
  invalid: r.invalid,
  attempts: r.attempts,
  leaseOwner: r.lease_owner,
  leaseUntil: num(r.lease_until),
  author: r.author,
  createdAt: num(r.created_at),
  startedAt: nul(r.started_at),
  finishedAt: nul(r.finished_at),
  reportAt: nul(r.report_at),
  updatedAt: num(r.updated_at),
});

export function createPushJobsDb(prisma: PrismaClient): PushJobsDb {
  /*
   * READ COMMITTED: each transaction decides from what it reads after the
   * channel row's lock, and under REPEATABLE READ those reads would return
   * the snapshot taken before the wait (`rules/data.md`, the `LimitsDb` rule).
   */
  const inTx = <T>(fn: (t: Tx) => Promise<T>): Promise<T> =>
    prisma.$transaction(fn, { isolationLevel: "ReadCommitted" });

  /**
   * The mutex of every count-then-insert here. Only the channel row: these
   * transactions write no limit row and never take the team row afterwards,
   * so the limit lock order (team, then scope) cannot cycle with them.
   */
  async function lockPushChannel(t: Tx, channelId: string): Promise<void> {
    const live = await t.$queryRaw<{ id: string }[]>`
      SELECT id FROM channels
      WHERE id = ${channelId} AND kind = 'push' AND deleted_at IS NULL
      FOR UPDATE`;
    if (live.length === 0) throw channelGone();
  }

  const findJobRow = async (id: string): Promise<PushJobRow | undefined> => {
    const r = await prisma.push_jobs.findUnique({ where: { id } });
    return r ? toJob(r) : undefined;
  };

  return {
    createTemplate: (t) =>
      run(async () => {
        checkTemplate(t);
        try {
          return await inTx<PushTemplateWrite>(async (tx) => {
            await lockPushChannel(tx, t.channelId);
            const held = await tx.push_templates.count({
              where: { channel_id: t.channelId },
            });
            if (held >= PUSH_TEMPLATES_PER_CHANNEL)
              return { ok: false, reason: "cap" };
            const row = await tx.push_templates.create({
              data: {
                id: t.id,
                channel_id: t.channelId,
                name: t.name,
                title: t.title,
                body: t.body,
                data_json: JSON.stringify(t.data),
                created_by: t.by,
                updated_by: t.by,
                created_at: t.at,
                updated_at: t.at,
              },
            });
            return { ok: true, row: toTemplate(row) };
          });
        } catch (e) {
          if (!(e instanceof AppError) && isConflict(e))
            return { ok: false, reason: "name_taken" };
          throw e;
        }
      }),

    listTemplates: (channelId) =>
      run(async () => {
        const rows = await prisma.push_templates.findMany({
          where: { channel_id: channelId },
          orderBy: { name: "asc" },
        });
        return rows.map(toTemplate);
      }),

    findTemplate: (channelId, id) =>
      run(async () => {
        const r = await prisma.push_templates.findFirst({
          where: { id, channel_id: channelId },
        });
        return r ? toTemplate(r) : undefined;
      }),

    updateTemplate: (channelId, id, p, check) =>
      run(async () => {
        checkPatch(p);
        try {
          return await inTx<PushTemplateWrite | undefined>(async (tx) => {
            // The row's lock: the merge below reads what the last patch
            // wrote, and the next patch waits for this one.
            const locked = await tx.$queryRaw<{ id: string }[]>`
              SELECT id FROM push_templates
              WHERE id = ${id} AND channel_id = ${channelId}
              FOR UPDATE`;
            if (locked.length === 0) return undefined;
            const cur = await tx.push_templates.findUnique({
              where: { id: locked[0]!.id },
            });
            if (!cur) return undefined;
            const stored = toTemplate(cur);
            check?.({
              title: p.title ?? stored.title,
              body: p.body ?? stored.body,
              data: p.data ?? stored.data,
            });
            const row = await tx.push_templates.update({
              where: { id: cur.id },
              data: {
                ...(p.name !== undefined ? { name: p.name } : {}),
                ...(p.title !== undefined ? { title: p.title } : {}),
                ...(p.body !== undefined ? { body: p.body } : {}),
                ...(p.data !== undefined
                  ? { data_json: JSON.stringify(p.data) }
                  : {}),
                updated_by: p.by,
                updated_at: p.at,
              },
            });
            return { ok: true, row: toTemplate(row) };
          });
        } catch (e) {
          if (!(e instanceof AppError) && isConflict(e))
            return { ok: false as const, reason: "name_taken" as const };
          throw e;
        }
      }),

    deleteTemplate: (channelId, id) =>
      run(async () => {
        const gone = await prisma.push_templates.deleteMany({
          where: { id, channel_id: channelId },
        });
        return gone.count > 0;
      }),

    createUpload: (u) =>
      run(async () => {
        checkUpload(u);
        return inTx(async (tx) => {
          await lockPushChannel(tx, u.channelId);
          // Pending only: an upload every job of which has finished no
          // longer holds a place (`push_jobs_upload` answers both probes).
          const pending = await tx.$queryRaw<{ n: bigint | number }[]>`
            SELECT COUNT(*) AS n FROM \`push_uploads\` u
            WHERE u.\`channel_id\` = ${u.channelId}
              AND (
                NOT EXISTS (
                  SELECT 1 FROM \`push_jobs\` j
                  WHERE j.\`upload_id\` = u.\`id\`)
                OR EXISTS (
                  SELECT 1 FROM \`push_jobs\` j
                  WHERE j.\`upload_id\` = u.\`id\`
                    AND j.\`status\` IN ('queued', 'running'))
              )`;
          if (num(pending[0]?.n ?? 0) >= PUSH_UPLOADS_PER_CHANNEL) return false;
          await tx.push_uploads.create({
            data: {
              id: u.id,
              channel_id: u.channelId,
              size: u.size,
              created_by: u.createdBy,
              created_at: u.createdAt,
            },
          });
          return true;
        });
      }),

    findUpload: (channelId, id) =>
      run(async () => {
        const r = await prisma.push_uploads.findFirst({
          where: { id, channel_id: channelId },
        });
        return r ? toUpload(r) : undefined;
      }),

    deleteUpload: (channelId, id) =>
      run(() =>
        inTx<PushUploadRow | "in_use" | undefined>(async (tx) => {
          await lockPushChannel(tx, channelId);
          const row = await tx.push_uploads.findFirst({
            where: { id, channel_id: channelId },
          });
          if (!row) return undefined;
          const busy = await tx.push_jobs.findFirst({
            where: { upload_id: row.id, status: { in: UNFINISHED } },
            select: { id: true },
          });
          if (busy) return "in_use";
          await tx.push_uploads.delete({ where: { id: row.id } });
          return toUpload(row);
        }),
      ),

    listStaleUploads: (cutoff, limit, after) =>
      run(async () => {
        const n = checkBatch(limit);
        const rows = await prisma.push_uploads.findMany({
          where: {
            created_at: { lt: cutoff },
            ...(after
              ? {
                  OR: [
                    { created_at: { gt: after.createdAt } },
                    { created_at: after.createdAt, id: { gt: after.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ created_at: "asc" }, { id: "asc" }],
          take: n,
        });
        if (rows.length === 0) return [];
        const busy = new Set(
          (
            await prisma.push_jobs.findMany({
              where: {
                upload_id: { in: rows.map((r) => r.id) },
                status: { in: UNFINISHED },
              },
              select: { upload_id: true },
            })
          ).map((j) => ci(j.upload_id ?? "")),
        );
        return rows.filter((r) => !busy.has(ci(r.id))).map(toUpload);
      }),

    deleteUploads: (ids) =>
      run(async () => {
        if (ids.length === 0) return 0;
        checkBatch(ids.length);
        const gone = await prisma.push_uploads.deleteMany({
          where: { id: { in: [...ids] } },
        });
        return gone.count;
      }),

    deleteChannelUploads: (channelId, limit) =>
      run(async () => {
        const n = checkBatch(limit);
        return prisma.$executeRaw`
          DELETE FROM \`push_uploads\`
          WHERE \`channel_id\` = ${channelId}
          LIMIT ${Prisma.raw(String(n))}`;
      }),

    submitJob: (j, limit) =>
      run(async () => {
        checkJob(j, limit);
        const where = {
          channel_id_idempotency_key: {
            channel_id: j.channelId,
            idempotency_key: j.idempotencyKey,
          },
        };
        const replay = (held: JobModel): PushJobSubmit =>
          held.params_hash === j.paramsHash
            ? { ok: true, created: false, job: toJob(held) }
            : { ok: false, reason: "params_differ" };
        try {
          return await inTx<PushJobSubmit>(async (tx) => {
            await lockPushChannel(tx, j.channelId);
            const held = await tx.push_jobs.findUnique({ where });
            if (held) return replay(held);
            const usage = await tx.push_jobs.count({
              where: {
                day: j.day,
                channel_id: j.channelId,
                dry_run: j.dryRun,
              },
            });
            if (usage >= limit)
              return { ok: false, reason: "day_cap", usage, limit };
            const row = await tx.push_jobs.create({
              data: {
                id: j.id,
                channel_id: j.channelId,
                kind: j.kind,
                dry_run: j.dryRun,
                idempotency_key: j.idempotencyKey,
                params_hash: j.paramsHash,
                template_id: j.templateId,
                title: j.title,
                body: j.body,
                data_json: JSON.stringify(j.data),
                options_json: JSON.stringify(j.options),
                upload_id: j.uploadId,
                upload_etag: j.uploadEtag,
                day: j.day,
                status: "queued",
                cancel_requested: false,
                cursor_row: 0,
                resolved: 0,
                sent: 0,
                no_token: 0,
                unregistered: 0,
                failed: 0,
                duplicates: 0,
                missing: 0,
                invalid: 0,
                attempts: 0,
                lease_until: 0,
                author: j.author,
                created_at: j.at,
                updated_at: j.at,
              },
            });
            return { ok: true, created: true, job: toJob(row) };
          });
        } catch (e) {
          // The channel row's lock already serialises submits; the unique
          // index is the backstop, and losing to it is a replay too.
          if (e instanceof AppError || !isConflict(e)) throw e;
          const held = await prisma.push_jobs.findUnique({ where });
          if (!held) throw e;
          return replay(held);
        }
      }),

    findJob: (channelId, id) =>
      run(async () => {
        const r = await prisma.push_jobs.findFirst({
          where: { id, channel_id: channelId },
        });
        return r ? toJob(r) : undefined;
      }),

    findJobByKey: (channelId, idempotencyKey) =>
      run(async () => {
        const r = await prisma.push_jobs.findUnique({
          where: {
            channel_id_idempotency_key: {
              channel_id: channelId,
              idempotency_key: idempotencyKey,
            },
          },
        });
        return r ? toJob(r) : undefined;
      }),

    listJobs: (channelId, { limit, before }) =>
      run(async () => {
        const n = checkBatch(limit);
        const rows = await prisma.push_jobs.findMany({
          where: {
            channel_id: channelId,
            ...(before
              ? {
                  OR: [
                    { created_at: { lt: before.createdAt } },
                    { created_at: before.createdAt, id: { lt: before.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
          take: n,
        });
        return rows.map(toJob);
      }),

    countJobsOfDay: (channelId, day) =>
      run(() =>
        prisma.push_jobs.count({
          where: { day, channel_id: channelId, dry_run: false },
        }),
      ),

    requestCancel: (channelId, id, at) =>
      run(async () => {
        await prisma.push_jobs.updateMany({
          where: {
            id,
            channel_id: channelId,
            status: { in: UNFINISHED },
            cancel_requested: false,
          },
          data: { cancel_requested: true, updated_at: at },
        });
        const r = await prisma.push_jobs.findFirst({
          where: { id, channel_id: channelId },
        });
        return r ? toJob(r) : undefined;
      }),

    claimJob: ({ owner, now, leaseSec }) =>
      run(async () => {
        // A lost race re-reads; three rounds are far more than one worker
        // container ever needs.
        for (let round = 0; round < 3; round++) {
          // One runnable job, of the channel served least recently. The
          // inner query touches the jobs of channels that have runnable
          // work only (`push_jobs_runnable`, then `push_jobs_channel`).
          const found = await prisma.$queryRaw<
            {
              id: string;
              lease_until: bigint | number;
              lease_owner: string | null;
            }[]
          >`
            SELECT j.\`id\`, j.\`lease_until\`, j.\`lease_owner\`
            FROM \`push_jobs\` j
            JOIN (
              SELECT a.\`channel_id\`,
                     MAX(GREATEST(a.\`lease_until\`,
                                  COALESCE(a.\`finished_at\`, 0))) AS served
              FROM \`push_jobs\` a
              WHERE a.\`channel_id\` IN (
                SELECT r.\`channel_id\` FROM \`push_jobs\` r
                WHERE r.\`status\` IN ('queued', 'running')
                  AND r.\`lease_until\` <= ${now})
              GROUP BY a.\`channel_id\`
            ) s ON s.\`channel_id\` = j.\`channel_id\`
            WHERE j.\`status\` IN ('queued', 'running')
              AND j.\`lease_until\` <= ${now}
            ORDER BY s.served ASC, j.\`lease_until\` ASC,
                     j.\`created_at\` ASC, j.\`id\` ASC
            LIMIT 1`;
          const cand = found[0];
          if (!cand) return undefined;
          const stalled = cand.lease_owner !== null;
          const won = await prisma.push_jobs.updateMany({
            where: {
              id: cand.id,
              status: { in: UNFINISHED },
              lease_until: cand.lease_until,
              lease_owner: cand.lease_owner,
            },
            data: {
              lease_owner: owner,
              lease_until: now + leaseSec,
              ...(stalled ? { attempts: { increment: 1 } } : {}),
              updated_at: now,
            },
          });
          if (won.count === 0) continue;
          const job = await findJobRow(cand.id);
          if (job) return { job, stalled };
        }
        return undefined;
      }),

    hasRunnableJob: (now) =>
      run(async () => {
        const r = await prisma.push_jobs.findFirst({
          where: { status: { in: UNFINISHED }, lease_until: { lte: now } },
          select: { id: true },
        });
        return r !== null;
      }),

    nextLeaseAt: (now) =>
      run(async () => {
        const r = await prisma.push_jobs.findFirst({
          where: { status: { in: UNFINISHED }, lease_until: { gt: now } },
          orderBy: { lease_until: "asc" },
          select: { lease_until: true },
        });
        return r ? num(r.lease_until) : undefined;
      }),

    countStaleJobs: (cutoff) =>
      run(() =>
        prisma.push_jobs.count({
          where: {
            status: { in: UNFINISHED },
            lease_until: { lte: cutoff },
            created_at: { lte: cutoff },
          },
        }),
      ),

    holdJob: (id, owner, h) =>
      run(async () => {
        // An identical write changes no row, so the fence is read back.
        await prisma.push_jobs.updateMany({
          where: { id, lease_owner: owner, status: { in: UNFINISHED } },
          data: { lease_until: h.now + h.leaseSec, updated_at: h.now },
        });
        const r = await prisma.push_jobs.findFirst({
          where: { id, lease_owner: owner, status: { in: UNFINISHED } },
        });
        return r ? toJob(r) : undefined;
      }),

    startJob: (id, owner, s) =>
      run(async () => {
        if (!Number.isInteger(s.total) || s.total < 0 || s.total > COUNT_MAX)
          throw bad("invalid total");
        // Affected rows, not matched ones: the row lookup below is what
        // tells a repeated start from a lost lease.
        await prisma.$executeRaw`
          UPDATE \`push_jobs\`
          SET \`status\` = 'running', \`total\` = ${s.total},
              \`started_at\` = COALESCE(\`started_at\`, ${s.at}),
              \`updated_at\` = ${s.at}
          WHERE \`id\` = ${id} AND \`lease_owner\` = ${owner}
            AND \`status\` IN ('queued', 'running')`;
        const r = await prisma.push_jobs.findFirst({
          where: { id, lease_owner: owner, status: "running" },
          select: { id: true },
        });
        return r !== null;
      }),

    advanceJob: (id, owner, a) =>
      run(async () => {
        const add = checkAdd(a.add);
        if (!Number.isInteger(a.to) || a.to <= a.from)
          throw bad("invalid cursor");
        const done = await prisma.push_jobs.updateMany({
          where: {
            id,
            lease_owner: owner,
            status: "running",
            cursor_row: a.from,
          },
          data: {
            cursor_row: a.to,
            resolved: { increment: add.resolved },
            sent: { increment: add.sent },
            no_token: { increment: add.noToken },
            unregistered: { increment: add.unregistered },
            failed: { increment: add.failed },
            duplicates: { increment: add.duplicates },
            missing: { increment: add.missing },
            invalid: { increment: add.invalid },
            attempts: 0,
            ...(a.detail !== undefined
              ? { error_detail: detailJson(a.detail) }
              : {}),
            lease_until: a.now + a.leaseSec,
            updated_at: a.now,
          },
        });
        if (done.count === 0) return undefined;
        return findJobRow(id);
      }),

    releaseJob: (id, owner, r) =>
      run(async () => {
        const done = await prisma.push_jobs.updateMany({
          where: { id, lease_owner: owner, status: { in: UNFINISHED } },
          data: {
            lease_owner: null,
            lease_until: r.notBefore,
            ...(r.attempt ? { attempts: { increment: 1 } } : {}),
            updated_at: r.at,
          },
        });
        return done.count > 0;
      }),

    finishJob: (id, owner, f) =>
      run(async () => {
        const done = await prisma.push_jobs.updateMany({
          where: { id, lease_owner: owner, status: { in: UNFINISHED } },
          data: {
            status: f.status,
            error: f.error ?? null,
            error_detail: detailJson(f.errorDetail),
            report_at: f.reportAt ?? null,
            finished_at: f.at,
            lease_owner: null,
            lease_until: 0,
            updated_at: f.at,
          },
        });
        return done.count > 0;
      }),

    expireJobs: (cutoff, at, limit) =>
      run(async () => {
        const n = checkBatch(limit);
        return prisma.$executeRaw`
          UPDATE \`push_jobs\`
          SET \`status\` = 'failed', \`error\` = 'expired',
              \`error_detail\` = NULL, \`finished_at\` = ${at}, \`lease_owner\` = NULL,
              \`lease_until\` = 0, \`updated_at\` = ${at}
          WHERE \`status\` IN ('queued', 'running')
            AND \`created_at\` < ${cutoff}
          LIMIT ${Prisma.raw(String(n))}`;
      }),

    sweepFinishedJobs: (cutoff, limit) =>
      run(async () => {
        const n = checkBatch(limit);
        return prisma.$executeRaw`
          DELETE FROM \`push_jobs\`
          WHERE \`finished_at\` < ${cutoff}
          LIMIT ${Prisma.raw(String(n))}`;
      }),

    deleteChannelJobs: (channelId, limit) =>
      run(async () => {
        const n = checkBatch(limit);
        return prisma.$executeRaw`
          DELETE FROM \`push_jobs\`
          WHERE \`channel_id\` = ${channelId}
          LIMIT ${Prisma.raw(String(n))}`;
      }),

    jobStatsOfDay: (day, limit) =>
      run(async () => {
        const n = checkBatch(limit);
        // `day = ? AND dry_run = 0` over `push_jobs_day`; at most four
        // groups per channel that submitted a job that day.
        const groups = await prisma.push_jobs.groupBy({
          by: ["channel_id", "status"],
          where: { day, dry_run: false },
          _count: { _all: true },
        });
        const by = new Map<string, PushJobDayStats>();
        for (const g of groups) {
          const key = ci(g.channel_id);
          const s = by.get(key) ?? {
            channelId: g.channel_id,
            jobs: 0,
            failed: 0,
          };
          s.jobs += g._count._all;
          if (g.status === "failed") s.failed += g._count._all;
          by.set(key, s);
        }
        return sortDayStats([...by.values()]).slice(0, n);
      }),
  };
}

export interface MemoryPushJobsDeps {
  /**
   * The channel a write names (`createMemoryConsoleDb().channels.get`): the
   * real repository locks the row and refuses one that is missing,
   * soft-deleted or of another kind. Without the hook every such write is
   * `not_found`.
   */
  channel?: (
    id: string,
  ) => { kind: ChannelKind; deletedAt: number | null } | undefined;
}

/**
 * In-memory `PushJobsDb` for tests: same contract as the Prisma repository.
 * Every method is synchronous between its checks and its writes, which is the
 * fake's transaction.
 */
export function createMemoryPushJobsDb(
  deps: MemoryPushJobsDeps = {},
): PushJobsDb & {
  templates: Map<string, PushTemplateRow>;
  uploads: Map<string, PushUploadRow>;
  jobs: Map<string, PushJobRow>;
  /** The `ON DELETE CASCADE` of `push_templates_channel_fk`. */
  channelsPurged(ids: readonly string[]): void;
} {
  // Ids, channel ids, names and keys all sit on `utf8mb4_unicode_ci`.
  const templates = new Map<string, PushTemplateRow>();
  const uploads = new Map<string, PushUploadRow>();
  const jobs = new Map<string, PushJobRow>();
  const sameCh = (a: string, b: string) => ci(a) === ci(b);

  const requireChannel = (channelId: string): void => {
    const ch = deps.channel?.(channelId);
    if (!ch || ch.kind !== "push" || ch.deletedAt !== null) throw channelGone();
  };
  const unfinished = (j: PushJobRow) =>
    j.status === "queued" || j.status === "running";
  /** When a channel was last served: see `claimJob`. */
  const servedAt = (channelId: string) =>
    Math.max(
      0,
      ...[...jobs.values()]
        .filter((j) => sameCh(j.channelId, channelId))
        .map((j) => Math.max(j.leaseUntil, j.finishedAt ?? 0)),
    );
  const runnable = (now: number) => {
    const served = new Map<string, number>();
    const of = (j: PushJobRow) => {
      const key = ci(j.channelId);
      if (!served.has(key)) served.set(key, servedAt(j.channelId));
      return served.get(key)!;
    };
    return [...jobs.values()]
      .filter((j) => unfinished(j) && j.leaseUntil <= now)
      .sort(
        (a, b) =>
          of(a) - of(b) ||
          a.leaseUntil - b.leaseUntil ||
          a.createdAt - b.createdAt ||
          cmpBin(ci(a.id), ci(b.id)),
      );
  };
  /** Whether the upload holds one of the channel's pending places. */
  const pendingUpload = (u: PushUploadRow) => {
    const mine = [...jobs.values()].filter(
      (j) => j.uploadId !== null && ci(j.uploadId) === ci(u.id),
    );
    return mine.length === 0 || mine.some(unfinished);
  };
  const copy = (j: PushJobRow): PushJobRow => ({
    ...j,
    data: { ...j.data },
    options: { ...j.options },
    errorDetail: j.errorDetail ? { ...j.errorDetail } : null,
  });
  const templateOf = (channelId: string, id: string) => {
    const t = templates.get(ci(id));
    return t && sameCh(t.channelId, channelId) ? t : undefined;
  };
  const jobOf = (channelId: string, id: string) => {
    const j = jobs.get(ci(id));
    return j && sameCh(j.channelId, channelId) ? j : undefined;
  };
  const held = (id: string, owner: string) => {
    const j = jobs.get(ci(id));
    return j && j.leaseOwner === owner && unfinished(j) ? j : undefined;
  };
  const drop = <T extends { id: string }>(
    map: Map<string, T>,
    rows: readonly T[],
    n: number,
  ): number => {
    const batch = rows.slice(0, n);
    for (const r of batch) map.delete(ci(r.id));
    return batch.length;
  };

  return {
    templates,
    uploads,
    jobs,
    channelsPurged: (ids) => {
      for (const t of [...templates.values()])
        if (ids.some((id) => sameCh(id, t.channelId)))
          templates.delete(ci(t.id));
    },

    createTemplate: async (t) => {
      checkTemplate(t);
      requireChannel(t.channelId);
      const mine = [...templates.values()].filter((x) =>
        sameCh(x.channelId, t.channelId),
      );
      if (mine.length >= PUSH_TEMPLATES_PER_CHANNEL)
        return { ok: false, reason: "cap" };
      if (mine.some((x) => ci(x.name) === ci(t.name)))
        return { ok: false, reason: "name_taken" };
      if (templates.has(ci(t.id)))
        throw new AppError("conflict", "duplicate key");
      const row: PushTemplateRow = {
        id: t.id,
        channelId: t.channelId,
        name: t.name,
        title: t.title,
        body: t.body,
        data: { ...t.data },
        createdBy: t.by,
        updatedBy: t.by,
        createdAt: t.at,
        updatedAt: t.at,
      };
      templates.set(ci(t.id), row);
      return { ok: true, row: { ...row, data: { ...row.data } } };
    },

    listTemplates: async (channelId) =>
      [...templates.values()]
        .filter((t) => sameCh(t.channelId, channelId))
        .sort((a, b) => cmpBin(ci(a.name), ci(b.name)))
        .map((t) => ({ ...t, data: { ...t.data } })),

    findTemplate: async (channelId, id) => {
      const t = templateOf(channelId, id);
      return t && { ...t, data: { ...t.data } };
    },

    updateTemplate: async (channelId, id, p, check) => {
      checkPatch(p);
      const t = templateOf(channelId, id);
      if (!t) return undefined;
      check?.({
        title: p.title ?? t.title,
        body: p.body ?? t.body,
        data: p.data ?? { ...t.data },
      });
      if (
        p.name !== undefined &&
        [...templates.values()].some(
          (x) =>
            x !== t &&
            sameCh(x.channelId, channelId) &&
            ci(x.name) === ci(p.name!),
        )
      )
        return { ok: false, reason: "name_taken" };
      if (p.name !== undefined) t.name = p.name;
      if (p.title !== undefined) t.title = p.title;
      if (p.body !== undefined) t.body = p.body;
      if (p.data !== undefined) t.data = { ...p.data };
      t.updatedBy = p.by;
      t.updatedAt = p.at;
      return { ok: true, row: { ...t, data: { ...t.data } } };
    },

    deleteTemplate: async (channelId, id) => {
      const t = templateOf(channelId, id);
      return t ? templates.delete(ci(t.id)) : false;
    },

    createUpload: async (u) => {
      checkUpload(u);
      requireChannel(u.channelId);
      const mine = [...uploads.values()].filter(
        (x) => sameCh(x.channelId, u.channelId) && pendingUpload(x),
      );
      if (mine.length >= PUSH_UPLOADS_PER_CHANNEL) return false;
      if (uploads.has(ci(u.id)))
        throw new AppError("conflict", "duplicate key");
      uploads.set(ci(u.id), { ...u });
      return true;
    },

    findUpload: async (channelId, id) => {
      const u = uploads.get(ci(id));
      return u && sameCh(u.channelId, channelId) ? { ...u } : undefined;
    },

    deleteUpload: async (channelId, id) => {
      requireChannel(channelId);
      const u = uploads.get(ci(id));
      if (!u || !sameCh(u.channelId, channelId)) return undefined;
      if (
        [...jobs.values()].some(
          (j) =>
            unfinished(j) && j.uploadId !== null && ci(j.uploadId) === ci(u.id),
        )
      )
        return "in_use";
      uploads.delete(ci(u.id));
      return { ...u };
    },

    listStaleUploads: async (cutoff, limit, after) => {
      const n = checkBatch(limit);
      const page = [...uploads.values()]
        .filter(
          (u) =>
            u.createdAt < cutoff &&
            (!after ||
              u.createdAt > after.createdAt ||
              (u.createdAt === after.createdAt &&
                cmpBin(ci(u.id), ci(after.id)) > 0)),
        )
        .sort((a, b) => a.createdAt - b.createdAt || cmpBin(ci(a.id), ci(b.id)))
        .slice(0, n);
      const busy = new Set(
        [...jobs.values()]
          .filter((j) => unfinished(j) && j.uploadId !== null)
          .map((j) => ci(j.uploadId!)),
      );
      return page.filter((u) => !busy.has(ci(u.id))).map((u) => ({ ...u }));
    },

    deleteUploads: async (ids) => {
      if (ids.length === 0) return 0;
      checkBatch(ids.length);
      let gone = 0;
      for (const id of new Set(ids.map(ci))) if (uploads.delete(id)) gone++;
      return gone;
    },

    deleteChannelUploads: async (channelId, limit) =>
      drop(
        uploads,
        [...uploads.values()].filter((u) => sameCh(u.channelId, channelId)),
        checkBatch(limit),
      ),

    submitJob: async (j, limit) => {
      checkJob(j, limit);
      requireChannel(j.channelId);
      const mine = [...jobs.values()].filter((x) =>
        sameCh(x.channelId, j.channelId),
      );
      const same = mine.find(
        (x) => ci(x.idempotencyKey) === ci(j.idempotencyKey),
      );
      if (same)
        return same.paramsHash === j.paramsHash
          ? { ok: true, created: false, job: copy(same) }
          : { ok: false, reason: "params_differ" };
      const usage = mine.filter(
        (x) => x.day === j.day && x.dryRun === j.dryRun,
      ).length;
      if (usage >= limit) return { ok: false, reason: "day_cap", usage, limit };
      if (jobs.has(ci(j.id))) throw new AppError("conflict", "duplicate key");
      const row: PushJobRow = {
        id: j.id,
        channelId: j.channelId,
        kind: j.kind,
        dryRun: j.dryRun,
        idempotencyKey: j.idempotencyKey,
        paramsHash: j.paramsHash,
        templateId: j.templateId,
        title: j.title,
        body: j.body,
        data: { ...j.data },
        options: { ...j.options },
        uploadId: j.uploadId,
        uploadEtag: j.uploadEtag,
        day: j.day,
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
        author: j.author,
        createdAt: j.at,
        startedAt: null,
        finishedAt: null,
        reportAt: null,
        updatedAt: j.at,
      };
      jobs.set(ci(j.id), row);
      return { ok: true, created: true, job: copy(row) };
    },

    findJob: async (channelId, id) => {
      const j = jobOf(channelId, id);
      return j && copy(j);
    },

    findJobByKey: async (channelId, idempotencyKey) => {
      const j = [...jobs.values()].find(
        (x) =>
          sameCh(x.channelId, channelId) &&
          ci(x.idempotencyKey) === ci(idempotencyKey),
      );
      return j && copy(j);
    },

    listJobs: async (channelId, { limit, before }) => {
      const n = checkBatch(limit);
      return [...jobs.values()]
        .filter(
          (j) =>
            sameCh(j.channelId, channelId) &&
            (!before ||
              j.createdAt < before.createdAt ||
              (j.createdAt === before.createdAt &&
                cmpBin(ci(j.id), ci(before.id)) < 0)),
        )
        .sort((a, b) => b.createdAt - a.createdAt || cmpBin(ci(b.id), ci(a.id)))
        .slice(0, n)
        .map(copy);
    },

    countJobsOfDay: async (channelId, day) =>
      [...jobs.values()].filter(
        (j) => sameCh(j.channelId, channelId) && j.day === day && !j.dryRun,
      ).length,

    requestCancel: async (channelId, id, at) => {
      const j = jobOf(channelId, id);
      if (!j) return undefined;
      if (unfinished(j) && !j.cancelRequested) {
        j.cancelRequested = true;
        j.updatedAt = at;
      }
      return copy(j);
    },

    claimJob: async ({ owner, now, leaseSec }) => {
      const j = runnable(now)[0];
      if (!j) return undefined;
      const stalled = j.leaseOwner !== null;
      j.leaseOwner = owner;
      j.leaseUntil = now + leaseSec;
      if (stalled) j.attempts++;
      j.updatedAt = now;
      return { job: copy(j), stalled };
    },

    hasRunnableJob: async (now) => runnable(now).length > 0,

    nextLeaseAt: async (now) => {
      const later = [...jobs.values()]
        .filter((j) => unfinished(j) && j.leaseUntil > now)
        .map((j) => j.leaseUntil);
      return later.length === 0 ? undefined : Math.min(...later);
    },

    countStaleJobs: async (cutoff) =>
      [...jobs.values()].filter(
        (j) => unfinished(j) && j.leaseUntil <= cutoff && j.createdAt <= cutoff,
      ).length,

    holdJob: async (id, owner, h) => {
      const j = held(id, owner);
      if (!j) return undefined;
      j.leaseUntil = h.now + h.leaseSec;
      j.updatedAt = h.now;
      return copy(j);
    },

    startJob: async (id, owner, s) => {
      if (!Number.isInteger(s.total) || s.total < 0 || s.total > COUNT_MAX)
        throw bad("invalid total");
      const j = held(id, owner);
      if (!j) return false;
      j.status = "running";
      j.total = s.total;
      j.startedAt ??= s.at;
      j.updatedAt = s.at;
      return true;
    },

    advanceJob: async (id, owner, a) => {
      const add = checkAdd(a.add);
      if (!Number.isInteger(a.to) || a.to <= a.from)
        throw bad("invalid cursor");
      const j = held(id, owner);
      if (!j || j.status !== "running" || j.cursor !== a.from) return undefined;
      j.cursor = a.to;
      for (const k of PUSH_JOB_COUNT_KEYS) j[k] += add[k];
      j.attempts = 0;
      if (a.detail !== undefined) {
        const detail = detailJson(a.detail);
        j.errorDetail =
          detail === null
            ? null
            : (JSON.parse(detail) as Record<string, unknown>);
      }
      j.leaseUntil = a.now + a.leaseSec;
      j.updatedAt = a.now;
      return copy(j);
    },

    releaseJob: async (id, owner, r) => {
      const j = held(id, owner);
      if (!j) return false;
      j.leaseOwner = null;
      j.leaseUntil = r.notBefore;
      if (r.attempt) j.attempts++;
      j.updatedAt = r.at;
      return true;
    },

    finishJob: async (id, owner, f) => {
      const j = held(id, owner);
      if (!j) return false;
      j.status = f.status;
      j.error = f.error ?? null;
      const detail = detailJson(f.errorDetail);
      j.errorDetail =
        detail === null
          ? null
          : (JSON.parse(detail) as Record<string, unknown>);
      j.reportAt = f.reportAt ?? null;
      j.finishedAt = f.at;
      j.leaseOwner = null;
      j.leaseUntil = 0;
      j.updatedAt = f.at;
      return true;
    },

    expireJobs: async (cutoff, at, limit) => {
      const batch = [...jobs.values()]
        .filter((j) => unfinished(j) && j.createdAt < cutoff)
        .slice(0, checkBatch(limit));
      for (const j of batch) {
        j.status = "failed";
        j.error = "expired";
        j.errorDetail = null;
        j.finishedAt = at;
        j.leaseOwner = null;
        j.leaseUntil = 0;
        j.updatedAt = at;
      }
      return batch.length;
    },

    sweepFinishedJobs: async (cutoff, limit) =>
      drop(
        jobs,
        [...jobs.values()].filter(
          (j) => j.finishedAt !== null && j.finishedAt < cutoff,
        ),
        checkBatch(limit),
      ),

    deleteChannelJobs: async (channelId, limit) =>
      drop(
        jobs,
        [...jobs.values()].filter((j) => sameCh(j.channelId, channelId)),
        checkBatch(limit),
      ),

    jobStatsOfDay: async (day, limit) => {
      const n = checkBatch(limit);
      const by = new Map<string, PushJobDayStats>();
      for (const j of jobs.values()) {
        if (j.day !== day || j.dryRun) continue;
        const s = by.get(ci(j.channelId)) ?? {
          channelId: j.channelId,
          jobs: 0,
          failed: 0,
        };
        s.jobs++;
        if (j.status === "failed") s.failed++;
        by.set(ci(j.channelId), s);
      }
      return sortDayStats([...by.values()]).slice(0, n);
    },
  };
}
