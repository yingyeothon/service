import type {
  PushJob,
  PushJobOptions,
  PushMessageText,
  PushTemplate,
} from "../types";
import { errorMessage, fmtTime } from "./format";

/*
 * Push campaigns (`docs/push.md` *Campaigns*): the client half of the
 * server's template grammar and CSV header rules, and its refusals as
 * sentences. The server stays the judge; this side only saves a round trip
 * (and, for the CSV, an upload) on what it would refuse anyway.
 */

/** The server's `PUSH_TEMPLATE_NAME`. */
const TEMPLATE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const TEMPLATE_TITLE_MAX = 1024;
export const TEMPLATE_BODY_MAX = 4096;
export const PAYLOAD_MAX_BYTES = 4096;
export const DATA_KEYS_MAX = 64;
const DATA_KEY_MAX = 1024;
/** The server's `PUSH_VAR_NAME`: a variable, and a CSV column. */
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]{0,31})\}\}/g;
const RESERVED_DATA_KEY =
  /^(?:from|notification|message_type|google\..*|gcm\..*)$/;
// eslint-disable-next-line no-control-regex -- rejecting control chars is the point
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- rejecting control chars is the point
const CONTROL_BUT_NL_TAB = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const TTL_MAX_SEC = 28 * 24 * 3600;
const COLLAPSE_KEY = /^[\x21-\x7e]{1,64}$/;

/** The largest recipient CSV the server signs an upload for. */
export const CSV_MAX_BYTES = 102_401_024;
const CSV_ROW_MAX_BYTES = 1024;
const CSV_FIELD_MAX_BYTES = 512;
const CSV_COLUMNS_MAX = 32;
/** Bytes of the file the header check reads: two records' worth, as the server. */
export const CSV_HEAD_BYTES = 2 * CSV_ROW_MAX_BYTES;

export const PLACEHOLDER_HINT =
  "{{name}} is filled from the CSV column of that name: letters, digits and _, not starting with a digit, at most 32 characters, no blanks. Anything else is sent as written.";

/* ------------------------------------------------------------------ */
/* message form                                                        */
/* ------------------------------------------------------------------ */

/** One row of the data editor; a row with neither key nor value is ignored. */
export interface DataRow {
  key: string;
  value: string;
}

export interface MessageForm {
  title: string;
  body: string;
  data: DataRow[];
}

export const emptyMessage = (): MessageForm => ({
  title: "",
  body: "",
  data: [],
});

export const messageForm = (t: PushMessageText): MessageForm => ({
  title: t.title,
  body: t.body,
  data: Object.entries(t.data).map(([key, value]) => ({ key, value })),
});

const liveRows = (rows: DataRow[]): DataRow[] =>
  rows.filter((r) => r.key !== "" || r.value !== "");

/** The form as the API takes it. */
export const messageText = (f: MessageForm): PushMessageText => ({
  title: f.title,
  body: f.body,
  data: Object.fromEntries(liveRows(f.data).map((r) => [r.key, r.value])),
});

/** The variables a message names, sorted, each once. */
export function templateVars(t: PushMessageText): string[] {
  const names = new Set<string>();
  for (const s of [t.title, t.body, ...Object.values(t.data)])
    for (const m of s.matchAll(PLACEHOLDER)) names.add(m[1]!);
  return [...names].sort();
}

const fill = (s: string, value: (name: string) => string): string =>
  s.replace(PLACEHOLDER, (_all, name: string) => value(name));

/** `t` with every placeholder replaced in one pass; a value is never read again. */
export function renderMessage(
  t: PushMessageText,
  value: (name: string) => string,
): PushMessageText {
  return {
    title: fill(t.title, value),
    body: fill(t.body, value),
    data: Object.fromEntries(
      Object.entries(t.data).map(([k, v]) => [k, fill(v, value)]),
    ),
  };
}

/** The size the 4096-byte limit bounds: the JSON of data and notification. */
export function payloadBytes(t: PushMessageText): number {
  return new TextEncoder().encode(
    JSON.stringify({
      data: Object.keys(t.data).length > 0 ? t.data : undefined,
      notification:
        t.title !== "" ? { title: t.title, body: t.body } : undefined,
    }),
  ).length;
}

/**
 * What a row with these sample values would be sent as. A variable without
 * a sample keeps its `{{name}}`, and is listed in `missing`: the server
 * skips such a row (`missing-variable`).
 */
export function previewMessage(
  t: PushMessageText,
  samples: Record<string, string>,
): { message: PushMessageText; bytes: number; missing: string[] } {
  const missing = templateVars(t).filter((v) => (samples[v] ?? "") === "");
  const message = renderMessage(t, (name) =>
    (samples[name] ?? "") === "" ? `{{${name}}}` : samples[name]!,
  );
  return { message, bytes: payloadBytes(message), missing };
}

export function templateNameProblem(name: string): string | null {
  if (name === "") return "The name is required.";
  return TEMPLATE_NAME.test(name)
    ? null
    : "Letters, digits, . _ and -, starting with a letter or digit; at most 64 characters.";
}

export interface MessageProblems {
  title?: string;
  body?: string;
  data?: string;
  /** A rule of the message as a whole. */
  message?: string;
}

/** The server's `checkMessageText`, as one sentence per place. */
export function messageProblems(f: MessageForm): MessageProblems {
  const p: MessageProblems = {};
  if (f.title.length > TEMPLATE_TITLE_MAX)
    p.title = `At most ${TEMPLATE_TITLE_MAX.toLocaleString("en-US")} characters.`;
  else if (CONTROL.test(f.title))
    p.title = "A title is one line: no line break, tab or control character.";
  if (f.body.length > TEMPLATE_BODY_MAX)
    p.body = `At most ${TEMPLATE_BODY_MAX.toLocaleString("en-US")} characters.`;
  else if (CONTROL_BUT_NL_TAB.test(f.body))
    p.body = "Line breaks and tabs are the only control characters allowed.";
  else if (f.title === "" && f.body !== "") p.body = "A body needs a title.";
  const rows = liveRows(f.data);
  const keys = rows.map((r) => r.key);
  if (rows.length > DATA_KEYS_MAX) p.data = `At most ${DATA_KEYS_MAX} keys.`;
  else if (keys.includes("")) p.data = "Every value needs a key.";
  else if (new Set(keys).size !== keys.length) p.data = "A key appears twice.";
  else if (keys.some((k) => RESERVED_DATA_KEY.test(k)))
    p.data =
      "FCM reserves the keys from, notification, message_type, google.* and gcm.*.";
  else if (keys.some((k) => k.length > DATA_KEY_MAX))
    p.data = `A key holds at most ${DATA_KEY_MAX.toLocaleString("en-US")} characters.`;
  else if (
    rows.some((r) => CONTROL.test(r.key) || CONTROL_BUT_NL_TAB.test(r.value))
  )
    p.data = "A key or value holds a control character.";
  if (Object.keys(p).length > 0) return p;
  if (f.title === "" && rows.length === 0)
    return { message: "A title or at least one data key is required." };
  // Every placeholder counted as one byte: the least a variable can add.
  const least = payloadBytes(renderMessage(messageText(f), () => "x"));
  if (least > PAYLOAD_MAX_BYTES)
    return {
      message: `The message is ${least.toLocaleString("en-US")} bytes before any variable is filled in; a push message holds at most ${PAYLOAD_MAX_BYTES.toLocaleString("en-US")}.`,
    };
  return {};
}

export const hasProblems = (p: object): boolean => Object.keys(p).length > 0;

/* ------------------------------------------------------------------ */
/* delivery options                                                    */
/* ------------------------------------------------------------------ */

export interface OptionsForm {
  priority: "" | "high" | "normal";
  /** `NumberInput` hands back `""` while the field is empty. */
  ttlSec: number | string;
  collapseKey: string;
}

export const emptyOptions = (): OptionsForm => ({
  priority: "",
  ttlSec: "",
  collapseKey: "",
});

export function optionsProblems(o: OptionsForm): {
  ttlSec?: string;
  collapseKey?: string;
} {
  const p: { ttlSec?: string; collapseKey?: string } = {};
  if (
    o.ttlSec !== "" &&
    !(
      typeof o.ttlSec === "number" &&
      Number.isInteger(o.ttlSec) &&
      o.ttlSec >= 0 &&
      o.ttlSec <= TTL_MAX_SEC
    )
  )
    p.ttlSec = `Whole seconds from 0 to ${TTL_MAX_SEC.toLocaleString("en-US")} (28 days).`;
  if (o.collapseKey !== "" && !COLLAPSE_KEY.test(o.collapseKey))
    p.collapseKey = "1 to 64 printable ASCII characters, no blanks.";
  return p;
}

/** Only what was set: an unset option is left to FCM's default. */
export function jobOptions(o: OptionsForm): PushJobOptions {
  return {
    ...(o.priority !== "" ? { priority: o.priority } : {}),
    ...(typeof o.ttlSec === "number" ? { ttlSec: o.ttlSec } : {}),
    ...(o.collapseKey !== "" ? { collapseKey: o.collapseKey } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* recipient CSV header                                                */
/* ------------------------------------------------------------------ */

/** The server's `CsvFailure` plus the worker's two (`no_rows`, `missing_columns`). */
const CSV_REASONS: Record<string, string> = {
  empty: "the file is empty",
  invalid_utf8: "it is not valid UTF-8",
  nul_byte: "it holds a NUL byte",
  bare_cr: "a line ends in CR without LF",
  quote:
    "a quote stands where it may not (a field is quoted as a whole or not at all)",
  unterminated_quote: "a quoted field is never closed",
  row_too_long: "a record is over 1,024 bytes",
  field_too_long: "a field is over 512 bytes",
  too_many_columns: "it has more than 32 columns",
  column_count: "a row does not have as many fields as the header",
  header_name:
    "a column name is not a variable name (letters, digits and _, not starting with a digit, at most 32 characters)",
  duplicate_header: "a column name appears twice",
  user_column_missing: "it has no userId column (spelled exactly so)",
  token_column:
    "a column reads like a device token; recipients are named by userId only and a token must never be in the file",
  no_rows: "it has a header and no rows",
  missing_columns: "it lacks a column the template uses",
};

/** A CSV rule as a clause, for "The CSV was refused: …". */
export const csvReason = (reason: unknown): string =>
  (typeof reason === "string" ? CSV_REASONS[reason] : undefined) ??
  "it breaks a CSV rule";

/** The server's `isTokenColumn`. */
export function isTokenColumn(name: string): boolean {
  const n = name.toLowerCase().replace(/_/g, "");
  return (
    /^(?:fcm|device|registration|push|firebase|instance)?(?:token|tokens)$/.test(
      n,
    ) || /^(?:registration|instance)ids?$/.test(n)
  );
}

/**
 * The header record of a CSV from its first bytes, read as strictly as the
 * server reads it. `whole` says the bytes are the entire file, so a record
 * that does not end in them still ends.
 */
export function readCsvHeader(
  head: Uint8Array,
  whole: boolean,
): { columns: string[] } | { reason: string } {
  let at = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const columns: string[] = [];
  let field: number[] = [];
  let rowBytes = 0;
  let state: "start" | "plain" | "quoted" | "closed" = "start";
  let failure: string | undefined;
  const endField = (): void => {
    try {
      columns.push(decoder.decode(new Uint8Array(field)));
    } catch {
      failure ??= "invalid_utf8";
    }
    field = [];
    if (columns.length > CSV_COLUMNS_MAX) failure ??= "too_many_columns";
  };
  const add = (b: number): void => {
    if (field.length >= CSV_FIELD_MAX_BYTES) failure ??= "field_too_long";
    else field.push(b);
  };
  let ended = false;
  for (; at < head.length && !failure && !ended; at++) {
    const b = head[at]!;
    if (state !== "quoted" && (b === 0x0d || b === 0x0a)) {
      if (b === 0x0d) {
        const next = head[at + 1];
        // Past the end of a partial read the LF may still follow.
        if (next === undefined ? whole : next !== 0x0a) {
          failure = "bare_cr";
          break;
        }
        at++;
      }
      // An empty line before the header is skipped.
      if (state === "start" && columns.length === 0 && field.length === 0) {
        rowBytes = 0;
        continue;
      }
      ended = true;
      break;
    }
    if (++rowBytes > CSV_ROW_MAX_BYTES) failure = "row_too_long";
    else if (state === "quoted") {
      if (b === 0x22) state = "closed";
      else if (b === 0) failure = "nul_byte";
      else add(b);
    } else if (state === "closed" && b === 0x22) {
      add(b);
      state = "quoted";
    } else if (state === "closed" && b !== 0x2c) failure = "quote";
    else if (b === 0x2c) {
      endField();
      state = "start";
    } else if (b === 0x22) {
      if (state !== "start") failure = "quote";
      else state = "quoted";
    } else if (b === 0) failure = "nul_byte";
    else {
      add(b);
      state = "plain";
    }
  }
  if (failure) return { reason: failure };
  if (!ended) {
    // The record ran to the end of what was read.
    if (!whole) return { reason: "row_too_long" };
    if (state === "quoted") return { reason: "unterminated_quote" };
    if (state === "start" && columns.length === 0 && field.length === 0)
      return { reason: "empty" };
  }
  endField();
  if (failure) return { reason: failure };
  return { columns };
}

/** The header rules (`parseCsvHeader`), then the template's variables. */
export function csvHeaderProblem(
  columns: readonly string[],
  variables: readonly string[],
): string | null {
  const seen = new Set<string>();
  for (const name of columns) {
    if (!VAR_NAME.test(name)) return sentence(CSV_REASONS.header_name!);
    if (seen.has(name)) return sentence(CSV_REASONS.duplicate_header!);
    if (isTokenColumn(name))
      return `The column ${name} reads like a device token. Recipients are named by userId only; a device token must never be in the file.`;
    seen.add(name);
  }
  if (!seen.has("userId")) return sentence(CSV_REASONS.user_column_missing!);
  const missing = variables.filter((v) => !seen.has(v));
  return missing.length > 0 ? missingColumns(missing) : null;
}

const sentence = (clause: string): string =>
  `The CSV cannot be used: ${clause}.`;

const missingColumns = (names: readonly string[]): string =>
  `The CSV has no column for ${names.map((n) => `{{${n}}}`).join(", ")}, which the template uses.`;

export type CsvCheck =
  { ok: true; columns: string[] } | { ok: false; problem: string };

/** `Blob.arrayBuffer`, or a `FileReader` where a runtime lacks it. */
function readBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function")
    return blob.arrayBuffer().then((b) => new Uint8Array(b));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error("the file cannot be read"));
    reader.readAsArrayBuffer(blob);
  });
}

/** The whole pre-upload check of a picked file against a template. */
export async function checkCsvFile(
  file: File,
  variables: readonly string[],
): Promise<CsvCheck> {
  if (file.size === 0)
    return { ok: false, problem: sentence(CSV_REASONS.empty!) };
  if (file.size > CSV_MAX_BYTES)
    return {
      ok: false,
      problem: `The file is larger than ${CSV_MAX_BYTES.toLocaleString("en-US")} bytes, the most a recipient CSV may be (100,000 rows of 1,024 bytes and a header).`,
    };
  const head = await readBytes(file.slice(0, CSV_HEAD_BYTES));
  const r = readCsvHeader(head, file.size <= CSV_HEAD_BYTES);
  if ("reason" in r)
    return { ok: false, problem: sentence(csvReason(r.reason)) };
  const problem = csvHeaderProblem(r.columns, variables);
  return problem ? { ok: false, problem } : { ok: true, columns: r.columns };
}

/* ------------------------------------------------------------------ */
/* idempotency                                                         */
/* ------------------------------------------------------------------ */

/** A fresh `idempotencyKey` (`[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`). */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === "function") return `ui-${c.randomUUID()}`;
  const bytes = c.getRandomValues(new Uint8Array(16));
  return `ui-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * One key per distinct submit: the same parameters get the same key, so a
 * retry (a lost answer, a second click) is replayed by the server instead of
 * recorded twice, and changed parameters never meet `idempotency_key_reused`.
 */
export function createKeyRing(): (params: unknown) => string {
  const keys = new Map<string, string>();
  return (params) => {
    const sig = JSON.stringify(params);
    let key = keys.get(sig);
    if (!key) keys.set(sig, (key = newIdempotencyKey()));
    return key;
  };
}

/* ------------------------------------------------------------------ */
/* jobs                                                                */
/* ------------------------------------------------------------------ */

export const jobActive = (j: PushJob): boolean =>
  j.status === "queued" || j.status === "running";

export const jobKindLabel = (j: PushJob): string =>
  j.kind === "broadcast" ? "broadcast" : j.dryRun ? "dry run" : "campaign";

/** `canceled` is a failed job the member ended: not an alarm. */
export function jobStatus(j: PushJob): { label: string; tone: string } {
  if (j.status === "failed")
    return j.error === "canceled"
      ? { label: "canceled", tone: "neutral" }
      : { label: "failed", tone: "danger" };
  if (j.cancelRequested && jobActive(j))
    return { label: "canceling", tone: "warn" };
  return {
    label: j.status,
    tone:
      j.status === "done"
        ? "ok"
        : j.status === "running"
          ? "accent"
          : "neutral",
  };
}

const n = (v: number): string => v.toLocaleString("en-US");

export const jobProgress = (j: PushJob): string =>
  j.total === null ? "—" : `${n(j.processed)} / ${n(j.total)}`;

/** The row's one-line outcome; the drawer holds every count. */
export function jobSummary(j: PushJob): string {
  const c = j.counts;
  if (j.kind === "broadcast")
    return j.status === "done"
      ? "accepted by FCM"
      : j.status === "failed"
        ? "not sent"
        : "—";
  if (j.total === null) return "—";
  const rest = c.noToken + c.skipped;
  return j.dryRun
    ? `${n(c.resolved)} reachable · ${n(rest)} not`
    : `${n(c.sent)} sent · ${n(rest + c.unregistered + c.failed)} not`;
}

/** Label/number lines of a job's counts, in reading order. */
export function jobCountLines(j: PushJob): [string, string][] {
  const c = j.counts;
  if (j.kind === "broadcast")
    return [
      ["Firebase projects", j.total === null ? "—" : n(j.total)],
      ["Accepted by FCM", n(c.sent)],
      ["Refused", n(c.failed)],
    ];
  const skipped: [string, string][] = [
    ["Duplicates", n(c.duplicates)],
    ["Missing variables", n(c.missingVariables)],
    ["Invalid (user id, a value, or over 4,096 bytes)", n(c.invalid)],
  ];
  const rows: [string, string] = ["Rows", j.total === null ? "—" : n(j.total)];
  return j.dryRun
    ? [
        rows,
        ["Resolved (would be sent)", n(c.resolved)],
        ["No token", n(c.noToken)],
        ...skipped,
      ]
    : [
        rows,
        ["Sent", n(c.sent)],
        ["No token", n(c.noToken)],
        ["Unregistered (tokens removed)", n(c.unregistered)],
        ["Failed", n(c.failed)],
        ...skipped,
      ];
}

/** What `counts.invalid` holds, in the words of the report's `reason` column. */
export const INVALID_ROWS_HINT =
  "Invalid rows are the report's skipped rows with the reason invalid-user (not a player id), too-large (the message is over 4,096 bytes once filled in) or invalid-value (the row's value would put a control character into the message).";

/**
 * A cancel that arrived during the last batch: every row was processed, so
 * the job ended `done` with the request still on it. Not a failure.
 */
export const cancelMissed = (j: PushJob): boolean =>
  j.status === "done" && j.cancelRequested;

export const CANCEL_MISSED =
  "The job finished before the cancel took effect: its last batch was already running, so every row was processed.";

/**
 * Why a job failed (`job.error` with `job.errorDetails`, which the server
 * answers only for a failed job), as a sentence.
 */
export function jobErrorSentence(j: PushJob): string | null {
  if (j.error === null) return null;
  const d = j.errorDetails ?? {};
  switch (j.error) {
    case "canceled":
      return "Canceled. Rows sent before the cancel stay sent and are in the report.";
    case "csv_invalid": {
      const line = typeof d.line === "number" ? ` (line ${n(d.line)})` : "";
      return `The CSV was refused: ${csvReason(d.reason)}${line}. Nothing was sent.`;
    }
    case "recipients_over_limit":
      return `The CSV has more rows than this channel's Recipients per job limit${
        typeof d.value === "number" ? ` (${n(d.value)})` : ""
      }. Nothing was sent; split the file, or ask for more under Limits.`;
    case "upload_missing":
      return "The uploaded CSV was gone when the job read it. Upload the file again.";
    case "upload_changed":
      return "The uploaded CSV was replaced after the job was submitted; a job reads the file it was submitted with. Submit again.";
    case "channel_gone":
      return "The channel was deleted while the job ran.";
    case "channel_inactive":
      return "The channel expired or was disabled while the job ran. Extend it, then submit again.";
    case "not_registered":
      return "The channel lost its platform registration and holds no team sender key, so nothing could be sent.";
    case "sender_unavailable":
      return "FCM refused the platform's key, or the platform no longer holds the channel's Firebase project. This is platform-side; a platform admin has to look at it.";
    case "send_failed":
      return "No Firebase project accepted the broadcast.";
    case "stalled":
      return "The job was given up after five runs died without finishing it. The report lists the rows it reached.";
    case "expired":
      return "The job was still unfinished three days after it was submitted and was ended.";
    default:
      return `The job failed: ${j.error}.`;
  }
}

/** Why the report cannot be downloaded now, or `null` when it can. */
export function reportBlock(j: PushJob, member: boolean): string | null {
  if (j.kind === "broadcast") return "A broadcast has no report.";
  if (jobActive(j)) return "The report is ready when the job has finished.";
  if (j.report === null)
    return "This job ended before its first batch, so it has no report.";
  if (!j.report.available)
    return `The report expired on ${fmtTime(j.report.expiresAt)}; reports are kept for 7 days.`;
  if (!member)
    return "A report lists the channel's players, so only team members download it.";
  return null;
}

/* ------------------------------------------------------------------ */
/* refusals                                                            */
/* ------------------------------------------------------------------ */

/** Where a campaign refusal is shown. */
export type CampaignProblem =
  /** The picked CSV or its upload: shown at the file, and the upload is redone. */
  | { at: "file"; message: string; reupload?: boolean }
  | { at: "name" | "template"; message: string }
  /** `push.jobsPerDay` reached: the channel's Limits section takes the request. */
  | { at: "limit"; message: string }
  /** A condition of the platform, not of what was typed. */
  | { at: "platform"; message: string }
  | { at: "form"; message: string };

export type CampaignAction =
  "template" | "job" | "broadcast" | "cancel" | "report";

interface ErrorShape {
  status?: number;
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

/**
 * A template, upload, job, broadcast, cancel or report refusal as the
 * sentence to show and the place to show it. Read off the error object
 * rather than `instanceof ApiError`: the tests' mock carries no class.
 */
export function campaignProblem(
  e: unknown,
  action: CampaignAction,
): CampaignProblem {
  const { details, status, code, message } = e as ErrorShape;
  const nothing =
    action === "job" || action === "broadcast"
      ? "Nothing was sent"
      : "Nothing was changed";
  if (status === 429 || code === "rate_limited")
    return {
      at: "platform",
      message: `Too many writes in a row. ${nothing}; try again in a second.`,
    };
  // The browser's PUT to storage (`putToGrant`), not an API answer.
  if (code === "upload_failed")
    return {
      at: "file",
      message:
        "The upload of the CSV to storage failed. Nothing was submitted; try again.",
    };
  const d = (
    details && typeof details === "object" && !Array.isArray(details)
      ? details
      : {}
  ) as Record<string, unknown>;
  if (d.limit === "push.jobsPerDay")
    return {
      at: "limit",
      message: `This channel has submitted all ${
        typeof d.value === "number" ? `${n(d.value)} ` : ""
      }jobs it may today; a broadcast counts as one and a dry run does not. The count resets at 00:00 UTC.`,
    };
  switch (d.reason) {
    case "csv_invalid":
      return {
        at: "file",
        message: `The CSV was refused: ${csvReason(d.csv)}${
          typeof d.line === "number" ? ` (line ${n(d.line)})` : ""
        }. Nothing was sent.`,
      };
    case "csv_missing_columns":
      return {
        at: "file",
        message: Array.isArray(d.columns)
          ? missingColumns(d.columns.map(String))
          : "The CSV lacks a column the template uses.",
      };
    case "template_has_variables":
      return {
        at: "template",
        message:
          "A broadcast cannot hold {{variables}}: there is no row to fill them from.",
      };
    case "push_payload_too_large":
      return {
        at: "form",
        message: `The message is over ${n(PAYLOAD_MAX_BYTES)} bytes, the most a push message holds. Shorten the text or the data.`,
      };
    case "idempotency_key_reused":
      return {
        at: "form",
        message:
          "This submit was already recorded with other settings. Close the form and start again.",
      };
    case "upload_missing":
      return {
        at: "file",
        reupload: true,
        message:
          "The CSV did not reach storage. Nothing was sent; submit again to upload it anew.",
      };
    case "upload_size_mismatch":
      return {
        at: "file",
        reupload: true,
        message:
          "The stored CSV is not the size that was announced. Nothing was sent; submit again to upload it anew.",
      };
    case "upload_expired":
      return {
        at: "file",
        reupload: true,
        message:
          "The upload is older than 24 hours. Nothing was sent; submit again to upload the file anew.",
      };
    case "push_upload_cap":
      return {
        at: "form",
        message: `This channel already holds ${
          typeof d.max === "number" ? d.max : 20
        } pending recipient files. One stops counting when its jobs have finished, and an unused one is removed two days after it was made; try again later.`,
      };
    case "push_dry_run_cap":
      return {
        at: "form",
        // The cap is the server's constant: named from its answer.
        message: `This channel ran ${
          typeof d.max === "number" ? `its ${n(d.max)}` : "all its"
        } dry runs for today. The count resets at 00:00 UTC.`,
      };
    case "push_not_registered":
      return {
        at: "form",
        message:
          "This channel has neither a platform registration nor a team sender key, so it cannot send. A dry run still works.",
      };
    case "push_not_configured":
      return {
        at: "platform",
        message:
          "Push is not set up on this stage: the platform has no Firebase project provisioned here. Nothing in the form is wrong; a dry run still works.",
      };
    case "push_template_name_taken":
      return {
        at: "name",
        message:
          "Another template of this channel has that name (names differ by more than case).",
      };
    case "push_template_cap":
      return {
        at: "form",
        message: `A push channel holds at most ${
          typeof d.max === "number" ? d.max : 20
        } templates. Delete one first.`,
      };
    case "report_not_ready":
      return { at: "form", message: "The job has not finished yet." };
    case "report_absent":
      return {
        at: "form",
        message: "This job ended without a report.",
      };
  }
  // Each of the four below carries a reason. An answer without one (an
  // older server) is told by its status and message.
  const bare = d.reason === undefined;
  const storage =
    d.reason === "push_storage_unavailable" ||
    (bare && status === 503 && /storage/.test(String(message)));
  const sender =
    d.reason === "push_sender_unavailable" ||
    (bare && status === 503 && /sender/.test(String(message)));
  if (storage || sender || status === 503)
    return {
      at: "platform",
      message: storage
        ? "This stage has no storage for recipient files and reports yet. Nothing in the form is wrong; a platform admin has to set it up."
        : sender
          ? `The platform cannot send for this channel right now: it no longer holds the channel's Firebase project. ${nothing}; a platform admin has to look at it.`
          : action === "report"
            ? "The platform could not hand out the report right now. Try again in a minute."
            : `The platform could not serve this right now. ${nothing}; try again in a minute.`,
    };
  if (
    d.reason === "report_expired" ||
    d.reason === "channel_inactive" ||
    status === 410
  )
    return {
      at: "form",
      message:
        d.reason === "report_expired" || (bare && action === "report")
          ? "The report expired; reports are kept for 7 days."
          : action === "report"
            ? "The channel is expired or disabled. Extend it first."
            : "The channel is expired or disabled, so it cannot send. Extend it first.",
    };
  if (status === 404 && (action === "job" || action === "broadcast"))
    return {
      at: "template",
      message:
        "The template (or the uploaded file) no longer exists. Close the form and start again.",
    };
  return { at: "form", message: errorMessage(e) };
}

/** Templates a broadcast may use: the ones that name no variable. */
export const broadcastTemplates = (ts: readonly PushTemplate[]) =>
  ts.filter((t) => t.variables.length === 0);
