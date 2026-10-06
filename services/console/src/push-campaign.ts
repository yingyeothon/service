import { timingSafeEqual } from "node:crypto";
import {
  AppError,
  isActive,
  nowSec,
  sha256Hex,
  ulid,
  type Clock,
  type Logger,
} from "@yyt/core";
import {
  pushDay,
  toPushChannel,
  PUSH_AUTHOR_APIKEY,
  PUSH_IDEMPOTENCY_KEY,
  PUSH_TEMPLATE_NAME,
  PUSH_TEMPLATES_PER_CHANNEL,
  PUSH_UPLOADS_PER_CHANNEL,
  type ChannelRow,
  type ConsoleDb,
  type LimitsDb,
  type PushChannel,
  type PushJobOptions,
  type PushJobRow,
  type PushJobsDb,
  type PushMessageText,
  type PushTemplateRow,
} from "@yyt/console-db";
import {
  defineRoute,
  type AnyRoute,
  type HttpResult,
  type RouteContext,
} from "@yyt/http";
import type { PushPool } from "@yyt/push";
import type { Kv } from "@yyt/redis";
import { z } from "zod";
import type { ConsoleIdentity } from "./identity.js";
import { LIMITS, overLimit, resolveLimits } from "./limits.js";
import {
  createCsvReader,
  CsvError,
  parseCsvHeader,
  PUSH_CSV_ROW_MAX_BYTES,
  type CsvHeader,
} from "./push-csv.js";
import {
  pushReportKey,
  pushUploadKey,
  PUSH_CSV_CONTENT_TYPE,
  PUSH_REPORT_URL_TTL_SEC,
  PUSH_UPLOAD_URL_TTL_SEC,
  UploadReadError,
  type PushJobStore,
} from "./push-job-store.js";
import { pushCredentialsError, pushCredentialsOf } from "./push-send.js";
import {
  checkMessageText,
  literalMessage,
  templateVars,
} from "./push-template.js";
import { createChannelCredentialHelpers } from "./resources.js";
import type { ResourceHistory } from "./resources.js";
import type { TeamAccessHelpers } from "./team-access.js";

/*
 * Push campaigns (docs/decisions.md *Push notifications* #9, `docs/push.md`
 * *Campaigns*): templates, recipient uploads, jobs, reports and the
 * broadcast. Two route families over one implementation:
 *
 *   - `/channels/{id}/push/...` for a project member (session or `yyt_`
 *     token), templates included;
 *   - `/push-api/{channelId}/...` for the push channel's own apiKey, so a
 *     team's server can run a campaign without a member token. No cookie and
 *     no session count there, and templates are not served.
 *
 * A route only records the job; the `pushJob` worker sends. No response here
 * carries a device token or a Firebase project id.
 */

/** Largest recipient CSV: every row of the hard limit at its longest, plus a header. */
export const PUSH_CSV_MAX_BYTES =
  (LIMITS["push.recipientsPerJob"].hard + 1) * PUSH_CSV_ROW_MAX_BYTES;
/** A job may be submitted for an upload this long after its URL was issued. */
export const PUSH_UPLOAD_USABLE_SEC = 24 * 3600;
/** A finished job's report is offered this long (decisions #9). */
export const PUSH_REPORT_TTL_SEC = 7 * 24 * 3600;
/**
 * Dry runs per channel and UTC day. They do not count against
 * `push.jobsPerDay`; this constant is what bounds them, and no request
 * raises it.
 */
export const PUSH_DRY_RUNS_PER_DAY = 20;
/** A status read kicks the worker for a job that sat idle this long. */
export const PUSH_JOB_IDLE_KICK_SEC = 60;
const PUSH_TTL_MAX_SEC = 28 * 24 * 3600;

type Audit = (
  actorId: string | null,
  action: string,
  target: string | null,
  detail?: unknown,
) => Promise<void>;

export interface PushCampaignRoutesOptions {
  jobs: PushJobsDb;
  db: Pick<ConsoleDb, "findPushChannel" | "findMembersByIds">;
  limits: Pick<LimitsDb, "listOverrides">;
  access: Pick<TeamAccessHelpers, "projectResource">;
  /** Absent when the stage names no SSM path: a real job answers 503. */
  pool?: PushPool;
  /** Absent when the stage has no private bucket: uploads and reports answer 503. */
  store?: PushJobStore;
  /** Kicks the `pushJob` worker; absent = jobs wait for the daily sweep's kick. */
  invoke?: () => Promise<void>;
  kv: Kv;
  writeSlot: (id: Pick<ConsoleIdentity, "subject">) => Promise<void>;
  clock: Clock;
  logger: Logger;
  audit: Audit;
  history: ResourceHistory;
}

const id64 = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const dataIn = z.record(z.string().max(1024), z.unknown());
const messageIn = {
  title: z.string().optional(),
  body: z.string().optional(),
  data: dataIn.optional(),
};
const optionsIn = {
  priority: z.enum(["high", "normal"]).optional(),
  ttlSec: z.number().int().min(0).max(PUSH_TTL_MAX_SEC).optional(),
  collapseKey: z
    .string()
    .regex(/^[\x21-\x7e]{1,64}$/)
    .optional(),
};
const idempotencyKey = z.string().regex(PUSH_IDEMPOTENCY_KEY);
const templateName = z.string().regex(PUSH_TEMPLATE_NAME);

const templateCreateBody = z
  .object({ name: templateName, ...messageIn })
  .strict();
const templatePatchBody = z
  .object({ name: templateName.optional(), ...messageIn })
  .strict();
const uploadBody = z
  .object({ size: z.number().int().min(1).max(PUSH_CSV_MAX_BYTES) })
  .strict();
const jobBody = z
  .object({
    templateId: id64,
    uploadId: id64,
    idempotencyKey,
    dryRun: z.boolean().optional(),
    ...optionsIn,
  })
  .strict();
const broadcastBody = z
  .object({
    templateId: id64.optional(),
    ...messageIn,
    idempotencyKey,
    ...optionsIn,
  })
  .strict();
const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z
      .string()
      .regex(/^\d{1,12}\.[A-Za-z0-9_-]{1,64}$/)
      .optional(),
    /** The one job this key names, instead of a page. */
    idempotencyKey: idempotencyKey.optional(),
  })
  .strict();

const reply = (body: unknown, statusCode = 200): HttpResult => ({
  statusCode,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  },
  body: JSON.stringify(body),
});

const conflict = (message: string, details: Record<string, unknown>) =>
  new AppError("conflict", message, { details });
const channelInactive = () =>
  new AppError("gone", "channel expired or disabled", {
    details: { reason: "channel_inactive" },
  });

function optionsOf(b: PushJobOptions): PushJobOptions {
  return {
    ...(b.priority !== undefined ? { priority: b.priority } : {}),
    ...(b.ttlSec !== undefined ? { ttlSec: b.ttlSec } : {}),
    ...(b.collapseKey !== undefined ? { collapseKey: b.collapseKey } : {}),
  };
}

/** Who is calling, whichever family the route is of. */
interface Caller {
  channel: PushChannel;
  /** `push_jobs`.`author`: a member id, or `apikey`. */
  author: string;
  /** The audit row's actor; null for the apiKey. */
  actorId: string | null;
  /** The write slot of this caller: per member, or per channel for the apiKey. */
  slot: () => Promise<void>;
}

export function templateView(
  t: PushTemplateRow,
  loginOf: (id: string) => string | null = () => null,
) {
  return {
    id: t.id,
    channelId: t.channelId,
    name: t.name,
    title: t.title,
    body: t.body,
    data: t.data,
    /** The `{{variables}}` the message names: the CSV columns it needs. */
    variables: templateVars(t),
    createdBy: t.createdBy,
    createdByLogin: loginOf(t.createdBy),
    updatedBy: t.updatedBy,
    updatedByLogin: loginOf(t.updatedBy),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** A job as both families answer it. Counts only. */
export function jobView(j: PushJobRow, now: number) {
  const reportExpiresAt =
    j.reportAt === null ? null : j.reportAt + PUSH_REPORT_TTL_SEC;
  return {
    id: j.id,
    channelId: j.channelId,
    kind: j.kind,
    dryRun: j.dryRun,
    status: j.status,
    error: j.error,
    // A running job's detail is the worker's own progress note.
    errorDetails: j.status === "failed" ? j.errorDetail : null,
    cancelRequested: j.cancelRequested,
    idempotencyKey: j.idempotencyKey,
    templateId: j.templateId,
    uploadId: j.uploadId,
    message: { title: j.title, body: j.body, data: j.data },
    options: j.options,
    author: j.author,
    /** Rows of the CSV (a broadcast: Firebase projects); null until counted. */
    total: j.total,
    processed: j.cursor,
    counts: {
      resolved: j.resolved,
      sent: j.sent,
      noToken: j.noToken,
      unregistered: j.unregistered,
      failed: j.failed,
      skipped: j.duplicates + j.missing + j.invalid,
      duplicates: j.duplicates,
      missingVariables: j.missing,
      invalid: j.invalid,
    },
    report:
      reportExpiresAt === null
        ? null
        : { available: now < reportExpiresAt, expiresAt: reportExpiresAt },
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
  };
}

export function createPushCampaignRoutes({
  jobs,
  db,
  limits,
  access,
  pool,
  store,
  invoke,
  kv,
  writeSlot,
  clock,
  logger,
  audit,
  history,
}: PushCampaignRoutesOptions): AnyRoute[] {
  const { channel: memberChannel } = createChannelCredentialHelpers({
    access,
    history,
    clock,
    kind: "push",
  });
  const now = () => nowSec(clock);

  /* ---------------- callers ---------------- */

  function parsed(row: ChannelRow): PushChannel {
    try {
      const ch = toPushChannel(row);
      if (ch && typeof ch.config === "object" && typeof ch.secret === "object")
        return ch;
    } catch {
      // falls through to the refusal
    }
    throw new AppError("unavailable", "channel secret cannot be read");
  }

  /** A project member; `write` refuses a seatless admin like every member write. */
  async function member(
    ctx: Pick<RouteContext, "requireIdentity" | "params">,
    write: boolean,
  ): Promise<Caller> {
    const { id, row } = await memberChannel(ctx, write);
    return {
      channel: parsed(row),
      author: id.subject,
      actorId: id.subject,
      slot: () => writeSlot(id),
    };
  }

  /**
   * The push channel's own apiKey, as the state stack's send route takes it:
   * a bearer, compared in constant time, and nothing else -- an identity the
   * request may also carry (a cookie, a `yyt_` token) is not looked at.
   */
  async function apiKey(
    ctx: Pick<RouteContext, "bearer" | "params">,
  ): Promise<Caller> {
    // Before the `SELECT`: a request without a key costs nothing.
    if (!ctx.bearer) throw new AppError("unauthorized", "api key required");
    const ch = await db.findPushChannel(ctx.params.channelId ?? "");
    // An unknown channel and a wrong key answer alike: a caller without the
    // key cannot tell which channel ids exist.
    if (!ch) throw new AppError("unauthorized", "api key required");
    const stored = ch.secret.apiKey;
    const ok =
      typeof stored === "string" &&
      stored !== "" &&
      // Fixed-length digests, so neither the length nor a shared prefix of
      // the key leaks through timing (`rules/security.md`).
      timingSafeEqual(
        Buffer.from(sha256Hex(ctx.bearer), "hex"),
        Buffer.from(sha256Hex(stored), "hex"),
      );
    if (!ok) throw new AppError("unauthorized", "api key required");
    if (!isActive(ch, clock)) throw channelInactive();
    return {
      channel: ch,
      author: PUSH_AUTHOR_APIKEY,
      actorId: null,
      // One slot per channel: every server holding the key shares it.
      slot: () => writeSlot({ subject: `pushkey:${ch.id}` }),
    };
  }

  const requireLive = (c: Caller): void => {
    if (!isActive(c.channel, clock)) throw channelInactive();
  };
  const requireStore = (): PushJobStore => {
    if (!store)
      throw new AppError("unavailable", "push storage unavailable", {
        details: { reason: "push_storage_unavailable" },
      });
    return store;
  };
  const via = (c: Caller) => (c.actorId === null ? { via: "apikey" } : {});

  /** Fire-and-forget: a job that is recorded is never failed by its kick. */
  async function kick(jobId: string): Promise<void> {
    if (!invoke) return;
    try {
      await invoke();
    } catch (e) {
      logger.warn("push job kick failed", {
        jobId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Logins of the members a list names, in one query. */
  async function logins(ids: readonly string[]) {
    const uniq = [...new Set(ids.filter((id) => id !== PUSH_AUTHOR_APIKEY))];
    const rows = uniq.length === 0 ? [] : await db.findMembersByIds(uniq);
    const byId = new Map(rows.map((m) => [m.id, m.githubLogin] as const));
    return (id: string) => byId.get(id) ?? null;
  }

  /* ---------------- uploads ---------------- */

  async function createUpload(c: Caller, size: number): Promise<HttpResult> {
    requireLive(c);
    const s = requireStore();
    // No write slot: the submit that follows an upload needs the caller's,
    // and the channel's pending places are what bound this route.
    const at = now();
    const id = `pu_${ulid(at * 1000).toLowerCase()}`;
    const created = await jobs.createUpload({
      id,
      channelId: c.channel.id,
      size,
      createdBy: c.author,
      createdAt: at,
    });
    if (!created)
      throw conflict(
        `the channel holds ${PUSH_UPLOADS_PER_CHANNEL} pending uploads; delete one, or wait: an unused upload is removed two days after it was made`,
        { reason: "push_upload_cap", max: PUSH_UPLOADS_PER_CHANNEL },
      );
    let url: string;
    try {
      url = await s.presignUploadPut({
        key: pushUploadKey(c.channel.id, id),
        contentLength: size,
      });
    } catch (e) {
      // No URL was handed out: the row would only hold one of the 20 places.
      await jobs.deleteUploads([id]).catch(() => undefined);
      throw e;
    }
    return reply(
      {
        uploadId: id,
        url,
        method: "PUT",
        // Both are part of the signature: another type or length is refused.
        headers: {
          "content-type": PUSH_CSV_CONTENT_TYPE,
          "content-length": String(size),
        },
        expiresAt: at + PUSH_UPLOAD_URL_TTL_SEC,
        usableUntil: at + PUSH_UPLOAD_USABLE_SEC,
        maxBytes: PUSH_CSV_MAX_BYTES,
      },
      201,
    );
  }

  async function deleteUpload(c: Caller, uploadId: string): Promise<undefined> {
    // This one takes the slot: a delete frees a pending place, so the pair
    // create/delete is paced here.
    await c.slot();
    const gone = await jobs.deleteUpload(c.channel.id, uploadId);
    if (gone === undefined) throw new AppError("not_found", "upload not found");
    if (gone === "in_use")
      throw conflict("an unfinished job reads the upload", {
        reason: "upload_in_use",
      });
    if (store) {
      try {
        await store.remove([pushUploadKey(c.channel.id, gone.id)]);
      } catch {
        // The row is gone; the bucket's lifecycle rule takes the object.
        logger.warn("push upload object left", { channelId: c.channel.id });
      }
    }
    return undefined;
  }

  /**
   * The uploaded object as a job may read it: present, of the signed length,
   * with a header that parses. Returns the id as stored (the object's key is
   * made of it, and the caller's spelling may differ by case), the ETag and
   * the header.
   */
  async function inspectUpload(
    c: Caller,
    uploadId: string,
  ): Promise<{ id: string; etag: string; header: CsvHeader }> {
    const s = requireStore();
    const row = await jobs.findUpload(c.channel.id, uploadId);
    if (!row) throw new AppError("not_found", "upload not found");
    if (now() >= row.createdAt + PUSH_UPLOAD_USABLE_SEC)
      throw conflict("the upload is too old; upload the file again", {
        reason: "upload_expired",
      });
    const key = pushUploadKey(c.channel.id, row.id);
    const head = await s.headUpload(key);
    if (!head)
      throw conflict("nothing was uploaded to the upload's URL", {
        reason: "upload_missing",
      });
    if (head.size !== row.size)
      throw conflict("the uploaded object is not of the signed size", {
        reason: "upload_size_mismatch",
      });
    try {
      // The header is one record, so two records' worth of bytes hold it.
      const first = await s.readUpload(
        key,
        head.etag,
        0,
        Math.min(head.size, 2 * PUSH_CSV_ROW_MAX_BYTES),
      );
      const reader = createCsvReader();
      let fields: string[] | undefined;
      // A slice at a time: an error in a later record is the worker's to
      // report, with the whole file read.
      for (let at = 0; at < first.length && !fields; at += 256)
        fields = reader.push(first.subarray(at, at + 256))[0]?.fields;
      if (!fields && first.length === head.size)
        fields = reader.end()[0]?.fields;
      if (!fields) throw new CsvError("empty", 1);
      return { id: row.id, etag: head.etag, header: parseCsvHeader(fields) };
    } catch (e) {
      if (e instanceof CsvError)
        throw new AppError("bad_request", "the CSV cannot be read", {
          details: { reason: "csv_invalid", csv: e.reason, line: e.line },
        });
      if (e instanceof UploadReadError)
        throw conflict("the uploaded object changed while it was read", {
          reason: "upload_missing",
        });
      throw e;
    }
  }

  /* ---------------- jobs ---------------- */

  /** A replay of an idempotency key, answered before anything else is checked. */
  async function replayOf(
    c: Caller,
    key: string,
    paramsHash: string,
  ): Promise<HttpResult | undefined> {
    const held = await jobs.findJobByKey(c.channel.id, key);
    if (!held) return undefined;
    if (held.paramsHash !== paramsHash) throw keyReused();
    return reply({ job: jobView(held, now()), created: false });
  }

  const keyReused = () =>
    conflict("the idempotencyKey names a job with other parameters", {
      reason: "idempotency_key_reused",
    });

  async function requireSender(c: Caller): Promise<void> {
    const cred = await pushCredentialsOf(c.channel, pool, logger);
    if (!cred.ok) throw pushCredentialsError(cred.reason);
  }

  async function record(
    c: Caller,
    input: Omit<
      Parameters<PushJobsDb["submitJob"]>[0],
      "id" | "channelId" | "day" | "author" | "at"
    >,
    action: "push.job.submit" | "push.broadcast",
  ): Promise<HttpResult> {
    const at = now();
    const limit = input.dryRun
      ? PUSH_DRY_RUNS_PER_DAY
      : (
          await resolveLimits(
            limits,
            [{ kind: "channel", id: c.channel.id }],
            at,
          )
        )("push.jobsPerDay");
    const r = await jobs.submitJob(
      {
        ...input,
        id: `pj_${ulid(at * 1000).toLowerCase()}`,
        channelId: c.channel.id,
        day: pushDay(at),
        author: c.author,
        at,
      },
      limit,
    );
    if (!r.ok) {
      if (r.reason === "params_differ") throw keyReused();
      if (input.dryRun)
        throw conflict(
          `the channel ran ${r.limit} dry runs today; the count resets at 00:00 UTC`,
          { reason: "push_dry_run_cap", max: r.limit },
        );
      throw overLimit(
        "conflict",
        "push.jobsPerDay",
        r.limit,
        `the channel submitted ${r.usage} of ${r.limit} jobs today; the count resets at 00:00 UTC`,
      );
    }
    if (!r.created) return reply({ job: jobView(r.job, at), created: false });
    await audit(c.actorId, action, r.job.id, {
      channelId: c.channel.id,
      kind: r.job.kind,
      dryRun: r.job.dryRun,
      templateId: r.job.templateId,
      ...via(c),
    });
    await kick(r.job.id);
    return reply({ job: jobView(r.job, at), created: true }, 202);
  }

  async function submitJob(
    c: Caller,
    b: z.infer<typeof jobBody>,
  ): Promise<HttpResult> {
    requireLive(c);
    const dryRun = b.dryRun ?? false;
    const options = optionsOf(b);
    // Ids as stored: the platform mints them lower-case and the columns
    // compare without case, so the lower-case spelling is the stored one
    // and a replay is recognised before either row is read.
    const paramsHash = sha256Hex(
      JSON.stringify([
        "campaign",
        b.templateId.toLowerCase(),
        b.uploadId.toLowerCase(),
        dryRun,
        options,
      ]),
    );
    const replay = await replayOf(c, b.idempotencyKey, paramsHash);
    if (replay) return replay;
    await c.slot();
    const template = await jobs.findTemplate(c.channel.id, b.templateId);
    if (!template) throw new AppError("not_found", "template not found");
    const upload = await inspectUpload(c, b.uploadId);
    const missing = templateVars(template).filter(
      (v) => !upload.header.columns.includes(v),
    );
    if (missing.length > 0)
      throw new AppError(
        "bad_request",
        "the CSV lacks a column the template names",
        { details: { reason: "csv_missing_columns", columns: missing } },
      );
    // A dry run sends nothing, so it needs no sender.
    if (!dryRun) await requireSender(c);
    return record(
      c,
      {
        kind: "campaign",
        dryRun,
        idempotencyKey: b.idempotencyKey,
        paramsHash,
        templateId: template.id,
        title: template.title,
        body: template.body,
        data: template.data,
        options,
        uploadId: upload.id,
        uploadEtag: upload.etag,
      },
      "push.job.submit",
    );
  }

  async function broadcast(
    c: Caller,
    b: z.infer<typeof broadcastBody>,
  ): Promise<HttpResult> {
    requireLive(c);
    const inline =
      b.title !== undefined || b.body !== undefined || b.data !== undefined;
    if ((b.templateId !== undefined) === inline)
      throw new AppError(
        "bad_request",
        "give either templateId or an inline title/body/data",
      );
    const options = optionsOf(b);
    const paramsHash = sha256Hex(
      JSON.stringify([
        "broadcast",
        b.templateId?.toLowerCase() ?? null,
        inline ? [b.title ?? "", b.body ?? "", b.data ?? {}] : null,
        options,
      ]),
    );
    const replay = await replayOf(c, b.idempotencyKey, paramsHash);
    if (replay) return replay;
    await c.slot();
    let text: PushMessageText;
    let templateId: string | null = null;
    if (b.templateId !== undefined) {
      const template = await jobs.findTemplate(c.channel.id, b.templateId);
      if (!template) throw new AppError("not_found", "template not found");
      templateId = template.id;
      text = {
        title: template.title,
        body: template.body,
        data: template.data,
      };
    } else {
      text = checkMessageText(b);
    }
    // Refuses a message that names a variable: no row fills it.
    literalMessage(text);
    await requireSender(c);
    return record(
      c,
      {
        kind: "broadcast",
        dryRun: false,
        idempotencyKey: b.idempotencyKey,
        paramsHash,
        templateId,
        ...text,
        options,
        uploadId: null,
        uploadEtag: null,
      },
      "push.broadcast",
    );
  }

  async function jobOf(c: Caller, jobId: string): Promise<PushJobRow> {
    const j = await jobs.findJob(c.channel.id, jobId);
    if (!j) throw new AppError("not_found", "job not found");
    return j;
  }

  async function getJob(c: Caller, jobId: string): Promise<HttpResult> {
    const j = await jobOf(c, jobId);
    const at = now();
    // A job nobody works on: its kick was lost or its worker died. A reader
    // watching it kicks the worker again, at most once a minute per job.
    if (
      (j.status === "queued" || j.status === "running") &&
      j.leaseUntil <= at &&
      j.updatedAt <= at - PUSH_JOB_IDLE_KICK_SEC &&
      (await kv.set(`pushkick:${j.id}`, "1", {
        nx: true,
        ex: PUSH_JOB_IDLE_KICK_SEC,
      }))
    )
      await kick(j.id);
    return reply({ job: jobView(j, at) });
  }

  async function listJobs(
    c: Caller,
    q: z.infer<typeof listQuery>,
  ): Promise<HttpResult> {
    if (q.idempotencyKey !== undefined) {
      // The unique index, with its collation: case does not tell keys apart.
      const j = await jobs.findJobByKey(c.channel.id, q.idempotencyKey);
      return reply({ jobs: j ? [jobView(j, now())] : [], next: null });
    }
    const limit = q.limit ?? 20;
    let before: { createdAt: number; id: string } | undefined;
    if (q.cursor !== undefined) {
      const dot = q.cursor.indexOf(".");
      before = {
        createdAt: Number(q.cursor.slice(0, dot)),
        id: q.cursor.slice(dot + 1),
      };
    }
    const rows = await jobs.listJobs(c.channel.id, {
      limit: limit + 1,
      before,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const at = now();
    return reply({
      jobs: page.map((j) => jobView(j, at)),
      next: rows.length > limit && last ? `${last.createdAt}.${last.id}` : null,
    });
  }

  async function cancelJob(c: Caller, jobId: string): Promise<HttpResult> {
    await c.slot();
    const before = await jobOf(c, jobId);
    const j = await jobs.requestCancel(c.channel.id, before.id, now());
    if (!j) throw new AppError("not_found", "job not found");
    if (j.cancelRequested && !before.cancelRequested) {
      await audit(c.actorId, "push.job.cancel", j.id, {
        channelId: c.channel.id,
        ...via(c),
      });
      // The worker ends it: at once when idle, else between two batches.
      await kick(j.id);
    }
    return reply({ job: jobView(j, now()) });
  }

  async function report(c: Caller, jobId: string): Promise<HttpResult> {
    const j = await jobOf(c, jobId);
    const at = now();
    if (j.reportAt === null)
      throw conflict(
        j.status === "done" || j.status === "failed"
          ? "the job has no report"
          : "the job has not finished",
        {
          reason:
            j.status === "done" || j.status === "failed"
              ? "report_absent"
              : "report_not_ready",
        },
      );
    if (at >= j.reportAt + PUSH_REPORT_TTL_SEC)
      throw new AppError("gone", "the report expired", {
        details: { reason: "report_expired" },
      });
    const url = await requireStore().presignGet({
      key: pushReportKey(c.channel.id, j.id),
      filename: `push-report-${j.id}.csv`,
      ttlSec: PUSH_REPORT_URL_TTL_SEC,
    });
    return reply({
      url,
      expiresAt: at + PUSH_REPORT_URL_TTL_SEC,
      reportExpiresAt: j.reportAt + PUSH_REPORT_TTL_SEC,
    });
  }

  /* ---------------- templates (member only) ---------------- */

  const templateRefusal = (r: {
    ok: false;
    reason: "name_taken" | "cap";
  }): AppError =>
    r.reason === "cap"
      ? conflict(
          `a push channel holds at most ${PUSH_TEMPLATES_PER_CHANNEL} templates`,
          { reason: "push_template_cap", max: PUSH_TEMPLATES_PER_CHANNEL },
        )
      : conflict("a template of this channel already has that name", {
          reason: "push_template_name_taken",
        });

  const templateRoutes: AnyRoute[] = [
    defineRoute({
      method: "GET",
      path: "/channels/{id}/push/templates",
      auth: true,
      handler: async (ctx) => {
        const c = await member(ctx, false);
        const rows = await jobs.listTemplates(c.channel.id);
        const loginOf = await logins(
          rows.flatMap((t) => [t.createdBy, t.updatedBy]),
        );
        return reply({
          templates: rows.map((t) => templateView(t, loginOf)),
          max: PUSH_TEMPLATES_PER_CHANNEL,
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/channels/{id}/push/templates",
      auth: true,
      body: templateCreateBody,
      handler: async (ctx) => {
        const c = await member(ctx, true);
        const text = checkMessageText(ctx.body);
        await c.slot();
        const at = now();
        const r = await jobs.createTemplate({
          id: `pt_${ulid(at * 1000).toLowerCase()}`,
          channelId: c.channel.id,
          name: ctx.body.name,
          ...text,
          by: c.author,
          at,
        });
        if (!r.ok) throw templateRefusal(r);
        await audit(c.actorId, "push.template.create", r.row.id, {
          channelId: c.channel.id,
          name: r.row.name,
        });
        return reply(templateView(r.row, await logins([c.author])), 201);
      },
    }),
    defineRoute({
      method: "GET",
      path: "/channels/{id}/push/templates/{templateId}",
      auth: true,
      handler: async (ctx) => {
        const c = await member(ctx, false);
        const t = await jobs.findTemplate(
          c.channel.id,
          ctx.params.templateId ?? "",
        );
        if (!t) throw new AppError("not_found", "template not found");
        return reply(templateView(t, await logins([t.createdBy, t.updatedBy])));
      },
    }),
    defineRoute({
      method: "PATCH",
      path: "/channels/{id}/push/templates/{templateId}",
      auth: true,
      body: templatePatchBody,
      handler: async (ctx) => {
        const c = await member(ctx, true);
        const cur = await jobs.findTemplate(
          c.channel.id,
          ctx.params.templateId ?? "",
        );
        if (!cur) throw new AppError("not_found", "template not found");
        // The message is checked as a whole, as it will be after the write.
        const text = checkMessageText({
          title: ctx.body.title ?? cur.title,
          body: ctx.body.body ?? cur.body,
          data: ctx.body.data ?? cur.data,
        });
        await c.slot();
        // Only the fields the request named are written, and the merged
        // message is checked again under the row's lock: a concurrent patch
        // of another field is neither undone nor left unchecked.
        const r = await jobs.updateTemplate(
          c.channel.id,
          cur.id,
          {
            ...(ctx.body.name !== undefined ? { name: ctx.body.name } : {}),
            ...(ctx.body.title !== undefined ? { title: text.title } : {}),
            ...(ctx.body.body !== undefined ? { body: text.body } : {}),
            ...(ctx.body.data !== undefined ? { data: text.data } : {}),
            by: c.author,
            at: now(),
          },
          (next) => void checkMessageText(next),
        );
        if (!r) throw new AppError("not_found", "template not found");
        if (!r.ok) throw templateRefusal(r);
        await audit(c.actorId, "push.template.update", r.row.id, {
          channelId: c.channel.id,
          name: r.row.name,
        });
        return reply(
          templateView(r.row, await logins([r.row.createdBy, r.row.updatedBy])),
        );
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/channels/{id}/push/templates/{templateId}",
      auth: true,
      handler: async (ctx) => {
        const c = await member(ctx, true);
        await c.slot();
        const templateId = ctx.params.templateId ?? "";
        // A job keeps the text it was submitted with, so nothing depends on
        // the row.
        if (!(await jobs.deleteTemplate(c.channel.id, templateId)))
          throw new AppError("not_found", "template not found");
        await audit(c.actorId, "push.template.delete", templateId, {
          channelId: c.channel.id,
        });
        return undefined;
      },
    }),
  ];

  /* ---------------- the two families ---------------- */

  /** The job routes under `base`, for whoever `caller` admits. */
  const family = (
    base: string,
    auth: boolean,
    caller: (ctx: RouteContext, write: boolean) => Promise<Caller>,
  ): AnyRoute[] => [
    defineRoute({
      method: "POST",
      path: `${base}/uploads`,
      auth,
      body: uploadBody,
      handler: async (ctx) =>
        createUpload(await caller(ctx, true), ctx.body.size),
    }),
    defineRoute({
      method: "DELETE",
      path: `${base}/uploads/{uploadId}`,
      auth,
      handler: async (ctx) =>
        deleteUpload(await caller(ctx, true), ctx.params.uploadId ?? ""),
    }),
    defineRoute({
      method: "POST",
      path: `${base}/jobs`,
      auth,
      body: jobBody,
      handler: async (ctx) => submitJob(await caller(ctx, true), ctx.body),
    }),
    defineRoute({
      method: "GET",
      path: `${base}/jobs`,
      auth,
      query: listQuery,
      handler: async (ctx) => listJobs(await caller(ctx, false), ctx.query),
    }),
    defineRoute({
      method: "GET",
      path: `${base}/jobs/{jobId}`,
      auth,
      handler: async (ctx) =>
        getJob(await caller(ctx, false), ctx.params.jobId ?? ""),
    }),
    defineRoute({
      method: "POST",
      path: `${base}/jobs/{jobId}/cancel`,
      auth,
      handler: async (ctx) =>
        cancelJob(await caller(ctx, true), ctx.params.jobId ?? ""),
    }),
    defineRoute({
      method: "GET",
      path: `${base}/jobs/{jobId}/report`,
      auth,
      // A list of the channel's players: a member's read, not a seatless
      // admin's, although nothing is written.
      handler: async (ctx) =>
        report(await caller(ctx, true), ctx.params.jobId ?? ""),
    }),
    defineRoute({
      method: "POST",
      path: `${base}/broadcast`,
      auth,
      body: broadcastBody,
      handler: async (ctx) => broadcast(await caller(ctx, true), ctx.body),
    }),
  ];

  return [
    ...templateRoutes,
    ...family("/channels/{id}/push", true, member),
    // No `auth`: the credential is the channel's apiKey, which the identity
    // resolver (members and their tokens) does not know.
    ...family("/push-api/{channelId}", false, (ctx) => apiKey(ctx)),
  ];
}
