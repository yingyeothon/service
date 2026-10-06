import { describe, expect, it } from "vitest";
import {
  INVALID_ROWS_HINT,
  campaignProblem,
  cancelMissed,
  checkCsvFile,
  createKeyRing,
  csvHeaderProblem,
  isTokenColumn,
  jobCountLines,
  jobErrorSentence,
  jobOptions,
  jobStatus,
  jobSummary,
  messageProblems,
  messageText,
  newIdempotencyKey,
  optionsProblems,
  payloadBytes,
  previewMessage,
  readCsvHeader,
  renderMessage,
  reportBlock,
  templateNameProblem,
  templateVars,
  type MessageForm,
} from "../src/lib/pushCampaign";
import type { PushJob } from "../src/types";

/** An API refusal as the client throws it: a message plus `status`/`details`. */
const refusal = (status: number, details?: unknown, message = "refused") =>
  Object.assign(new Error(message), { status, details });

const form = (p: Partial<MessageForm> = {}): MessageForm => ({
  title: "Hi",
  body: "",
  data: [],
  ...p,
});
const bytes = (s: string) => new TextEncoder().encode(s);

export const JOB: PushJob = {
  id: "pj_1",
  channelId: "push_9",
  kind: "campaign",
  dryRun: false,
  status: "done",
  error: null,
  errorDetails: null,
  cancelRequested: false,
  idempotencyKey: "launch-1",
  templateId: "pt_1",
  uploadId: "pu_1",
  message: { title: "Hi {{name}}", body: "", data: {} },
  options: {},
  author: "m_1",
  total: 1200,
  processed: 1200,
  counts: {
    resolved: 1180,
    sent: 1170,
    noToken: 15,
    unregistered: 4,
    failed: 6,
    skipped: 5,
    duplicates: 3,
    missingVariables: 2,
    invalid: 0,
  },
  report: { available: true, expiresAt: 1_790_600_000 },
  createdAt: 1_790_000_000,
  startedAt: 1_790_000_002,
  finishedAt: 1_790_000_060,
};

describe("template grammar", () => {
  it("finds {{name}} placeholders and nothing else", () => {
    expect(
      templateVars({
        title: "Hi {{name}}, {{ name2 }} {{a.b}} {{}} {{",
        body: "{{score}} {{name}} {{1x}} {{_ok}}",
        data: { "{{key}}": "{{level}}", k: `{{${"x".repeat(33)}}}` },
      }),
    ).toEqual(["_ok", "level", "name", "score"]);
  });

  it("renders in one pass: a substituted value is never read again", () => {
    const out = renderMessage(
      { title: "{{a}}", body: "{{b}}", data: { k: "x{{a}}" } },
      (n) => (n === "a" ? "{{b}}" : "B"),
    );
    expect(out).toEqual({ title: "{{b}}", body: "B", data: { k: "x{{b}}" } });
  });

  it("previews with samples, keeps an unfilled placeholder and measures the payload", () => {
    const text = { title: "Hi {{name}}", body: "{{score}} pts", data: {} };
    const p = previewMessage(text, { name: "Al" });
    expect(p.message.title).toBe("Hi Al");
    expect(p.message.body).toBe("{{score}} pts");
    expect(p.missing).toEqual(["score"]);
    expect(p.bytes).toBe(
      bytes(
        JSON.stringify({
          notification: { title: "Hi Al", body: "{{score}} pts" },
        }),
      ).length,
    );
    // Data only: no notification object; UTF-8 bytes, not characters.
    expect(payloadBytes({ title: "", body: "", data: { k: "한" } })).toBe(
      bytes('{"data":{"k":"한"}}').length,
    );
  });
});

describe("messageProblems", () => {
  it("accepts a title, and a data-only message", () => {
    expect(messageProblems(form())).toEqual({});
    expect(
      messageProblems(form({ title: "", data: [{ key: "k", value: "v" }] })),
    ).toEqual({});
  });

  it("mirrors the server's rules, one sentence per place", () => {
    expect(messageProblems(form({ title: "x".repeat(1025) })).title).toMatch(
      /At most 1,024/,
    );
    expect(messageProblems(form({ title: "a\nb" })).title).toMatch(/one line/);
    expect(messageProblems(form({ body: "a\nb\tc" }))).toEqual({});
    expect(messageProblems(form({ body: "a\u0007" })).body).toMatch(
      /Line breaks and tabs/,
    );
    expect(messageProblems(form({ body: "x".repeat(4097) })).body).toMatch(
      /At most 4,096/,
    );
    expect(messageProblems(form({ title: "", body: "b" })).body).toBe(
      "A body needs a title.",
    );
    expect(messageProblems(form({ title: "" })).message).toMatch(
      /A title or at least one data key/,
    );
    const data = (rows: [string, string][]) =>
      messageProblems(
        form({ data: rows.map(([key, value]) => ({ key, value })) }),
      ).data;
    expect(data([["", "v"]])).toMatch(/needs a key/);
    expect(
      data([
        ["k", "1"],
        ["k", "2"],
      ]),
    ).toMatch(/twice/);
    for (const k of [
      "from",
      "notification",
      "message_type",
      "google.x",
      "gcm.y",
    ])
      expect(data([[k, "v"]])).toMatch(/FCM reserves/);
    expect(data([["k", "a\u0000"]])).toMatch(/control character/);
    expect(data(Array.from({ length: 65 }, (_v, i) => [`k${i}`, "v"]))).toMatch(
      /At most 64 keys/,
    );
    // An untouched row is not data.
    expect(data([["", ""]])).toBeUndefined();
    expect(messageText(form({ data: [{ key: "", value: "" }] })).data).toEqual(
      {},
    );
  });

  it("refuses literal text over the payload limit, a placeholder counted as one byte", () => {
    const p = messageProblems(
      form({ title: "t", body: "x".repeat(4090), data: [] }),
    );
    expect(p.message).toMatch(/bytes before any variable is filled in/);
    // 40 bytes of JSON around a 4,056-character body: exactly the limit…
    const fits = { title: "t", body: "x".repeat(4056) };
    expect(payloadBytes({ ...fits, data: {} })).toBe(4096);
    expect(messageProblems(form(fits))).toEqual({});
    // …and a placeholder in its place counts one byte, not its own length.
    expect(
      messageProblems(
        form({ title: "t", body: `${"x".repeat(4055)}{{name}}` }),
      ),
    ).toEqual({});
  });

  it("checks the template name", () => {
    expect(templateNameProblem("")).toMatch(/required/);
    for (const ok of ["welcome", "A.b_c-1", "9lives"])
      expect(templateNameProblem(ok)).toBeNull();
    for (const bad of ["-x", "a b", "x".repeat(65), "한"])
      expect(templateNameProblem(bad)).toMatch(/Letters, digits/);
  });
});

describe("delivery options", () => {
  it("sends only what was set", () => {
    expect(jobOptions({ priority: "", ttlSec: "", collapseKey: "" })).toEqual(
      {},
    );
    expect(
      jobOptions({ priority: "high", ttlSec: 0, collapseKey: "k" }),
    ).toEqual({ priority: "high", ttlSec: 0, collapseKey: "k" });
  });

  it("bounds the ttl and the collapse key", () => {
    const p = (ttlSec: number | string, collapseKey = "") =>
      optionsProblems({ priority: "", ttlSec, collapseKey });
    expect(p("")).toEqual({});
    expect(p(2_419_200)).toEqual({});
    expect(p(2_419_201).ttlSec).toMatch(/28 days/);
    expect(p(1.5).ttlSec).toMatch(/Whole seconds/);
    expect(p("", "a b").collapseKey).toMatch(/printable ASCII/);
    expect(p("", "x".repeat(65)).collapseKey).toBeDefined();
  });
});

describe("recipient CSV header", () => {
  const header = (s: string, whole = true) => readCsvHeader(bytes(s), whole);

  it("reads the first record strictly", () => {
    expect(header("userId,name\nu1,Al\n")).toEqual({
      columns: ["userId", "name"],
    });
    expect(header("﻿userId,name\r\nu1,Al")).toEqual({
      columns: ["userId", "name"],
    });
    expect(header('"userId","na""me"')).toEqual({
      columns: ["userId", 'na"me'],
    });
    expect(header("\n\nuserId\n")).toEqual({ columns: ["userId"] });
    expect(header("")).toEqual({ reason: "empty" });
    expect(header("\n")).toEqual({ reason: "empty" });
    expect(header('user"Id,name\n')).toEqual({ reason: "quote" });
    expect(header('"userId"x,name\n')).toEqual({ reason: "quote" });
    expect(header('"userId,name')).toEqual({ reason: "unterminated_quote" });
    expect(header("userId\rname\n")).toEqual({ reason: "bare_cr" });
    expect(header("userId,a\u0000\n")).toEqual({ reason: "nul_byte" });
    expect(header(`userId,${"x".repeat(513)}\n`)).toEqual({
      reason: "field_too_long",
    });
    expect(
      header(`${Array.from({ length: 33 }, (_v, i) => `c${i}`).join(",")}\n`),
    ).toEqual({ reason: "too_many_columns" });
    expect(readCsvHeader(new Uint8Array([0x75, 0xff, 0x0a]), true)).toEqual({
      reason: "invalid_utf8",
    });
    // A record that does not end within what was read.
    expect(header("userId,name", false)).toEqual({ reason: "row_too_long" });
  });

  it("applies the header rules, then the template's variables", () => {
    expect(csvHeaderProblem(["userId", "name"], ["name"])).toBeNull();
    expect(csvHeaderProblem(["userId", "extra"], [])).toBeNull();
    expect(csvHeaderProblem(["userid"], [])).toMatch(/no userId column/);
    expect(csvHeaderProblem(["userId", "na me"], [])).toMatch(
      /not a variable name/,
    );
    expect(csvHeaderProblem(["userId", "a", "a"], [])).toMatch(/twice/);
    expect(csvHeaderProblem(["userId", "fcm_token"], [])).toMatch(
      /fcm_token reads like a device token/,
    );
    expect(csvHeaderProblem(["userId"], ["name", "score"])).toBe(
      "The CSV has no column for {{name}}, {{score}}, which the template uses.",
    );
  });

  it("knows a token-like column as the server does", () => {
    for (const t of [
      "token",
      "Tokens",
      "deviceToken",
      "fcm_token",
      "registrationToken",
      "registration_id",
      "pushToken",
      "instanceIds",
    ])
      expect(isTokenColumn(t)).toBe(true);
    for (const ok of ["userId", "tokenCount", "name", "id"])
      expect(isTokenColumn(ok)).toBe(false);
  });

  it("checks a picked file before anything is uploaded", async () => {
    const file = (s: string) => new File([s], "r.csv", { type: "text/csv" });
    expect(await checkCsvFile(file("userId,name\nu1,Al\n"), ["name"])).toEqual({
      ok: true,
      columns: ["userId", "name"],
    });
    expect(await checkCsvFile(file(""), [])).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/empty/) as string,
    });
    expect(await checkCsvFile(file("name\nAl\n"), [])).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/no userId column/) as string,
    });
    // Only the head is read: a long file costs one slice.
    const long = file(`userId\n${"u\n".repeat(5000)}`);
    expect(await checkCsvFile(long, [])).toEqual({
      ok: true,
      columns: ["userId"],
    });
  });
});

describe("idempotency keys", () => {
  it("mints keys the server's grammar takes", () => {
    expect(newIdempotencyKey()).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });

  it("gives the same submit the same key and another submit another", () => {
    const keyOf = createKeyRing();
    const a = keyOf({ templateId: "pt_1", uploadId: "pu_1" });
    expect(keyOf({ templateId: "pt_1", uploadId: "pu_1" })).toBe(a);
    expect(
      keyOf({ templateId: "pt_1", uploadId: "pu_1", dryRun: true }),
    ).not.toBe(a);
    expect(createKeyRing()({ templateId: "pt_1", uploadId: "pu_1" })).not.toBe(
      a,
    );
  });
});

describe("jobs", () => {
  it("summarises a job in one line and lists every count", () => {
    expect(jobSummary(JOB)).toBe("1,170 sent · 30 not");
    const dry = { ...JOB, dryRun: true };
    expect(jobSummary(dry)).toBe("1,180 reachable · 20 not");
    expect(jobCountLines(dry)).toEqual([
      ["Rows", "1,200"],
      ["Resolved (would be sent)", "1,180"],
      ["No token", "15"],
      ["Duplicates", "3"],
      ["Missing variables", "2"],
      ["Invalid (user id, a value, or over 4,096 bytes)", "0"],
    ]);
    expect(jobCountLines(JOB).map(([l]) => l)).toContain("Sent");
    const broadcast: PushJob = { ...JOB, kind: "broadcast", total: 2 };
    expect(jobSummary(broadcast)).toBe("accepted by FCM");
    expect(jobCountLines(broadcast)[0]).toEqual(["Firebase projects", "2"]);
    expect(jobSummary({ ...JOB, status: "queued", total: null })).toBe("—");
  });

  it("shows a cancel as its own status", () => {
    expect(jobStatus(JOB)).toEqual({ label: "done", tone: "ok" });
    expect(
      jobStatus({ ...JOB, status: "failed", error: "canceled" }).label,
    ).toBe("canceled");
    expect(jobStatus({ ...JOB, status: "failed", error: "stalled" })).toEqual({
      label: "failed",
      tone: "danger",
    });
    expect(
      jobStatus({ ...JOB, status: "running", cancelRequested: true }).label,
    ).toBe("canceling");
  });

  it("knows a cancel that came during the last batch from a failure", () => {
    const late = { ...JOB, cancelRequested: true };
    expect(cancelMissed(late)).toBe(true);
    // Still a finished job, with no error to explain.
    expect(jobStatus(late)).toEqual({ label: "done", tone: "ok" });
    expect(jobErrorSentence(late)).toBeNull();
    expect(cancelMissed(JOB)).toBe(false);
    expect(
      cancelMissed({ ...JOB, status: "running", cancelRequested: true }),
    ).toBe(false);
    expect(
      cancelMissed({
        ...JOB,
        status: "failed",
        error: "canceled",
        cancelRequested: true,
      }),
    ).toBe(false);
    expect(INVALID_ROWS_HINT).toMatch(/invalid-user.*too-large.*invalid-value/);
  });

  it("has a sentence for every job.error of the server", () => {
    const failed = (
      error: string,
      errorDetails: PushJob["errorDetails"] = null,
    ) => jobErrorSentence({ ...JOB, status: "failed", error, errorDetails });
    expect(jobErrorSentence(JOB)).toBeNull();
    expect(failed("canceled")).toMatch(/^Canceled\./);
    expect(failed("csv_invalid", { reason: "column_count", line: 42 })).toBe(
      "The CSV was refused: a row does not have as many fields as the header (line 42). Nothing was sent.",
    );
    expect(failed("csv_invalid", { reason: "no_rows", line: 1 })).toMatch(
      /a header and no rows/,
    );
    expect(
      failed("csv_invalid", { reason: "missing_columns", line: 1 }),
    ).toMatch(/lacks a column the template uses/);
    expect(
      failed("recipients_over_limit", {
        limit: "push.recipientsPerJob",
        value: 10000,
      }),
    ).toMatch(/Recipients per job limit \(10,000\).*Nothing was sent/);
    expect(failed("upload_missing")).toMatch(/Upload the file again/);
    expect(failed("upload_changed")).toMatch(/replaced after the job/);
    expect(failed("channel_gone")).toMatch(/channel was deleted/);
    expect(failed("channel_inactive")).toMatch(/expired or was disabled/);
    expect(failed("not_registered")).toMatch(/no team sender key/);
    expect(failed("sender_unavailable")).toMatch(/platform-side/);
    expect(failed("send_failed")).toMatch(/No Firebase project accepted/);
    expect(failed("stalled")).toMatch(/five runs/);
    expect(failed("expired")).toMatch(/three days/);
    expect(failed("something_new")).toBe("The job failed: something_new.");
  });

  it("says why a report cannot be downloaded", () => {
    expect(reportBlock(JOB, true)).toBeNull();
    expect(reportBlock(JOB, false)).toMatch(/only team members/);
    expect(reportBlock({ ...JOB, kind: "broadcast" }, true)).toMatch(
      /broadcast has no report/,
    );
    expect(
      reportBlock({ ...JOB, status: "running", report: null }, true),
    ).toMatch(/when the job has finished/);
    expect(
      reportBlock({ ...JOB, status: "failed", report: null }, true),
    ).toMatch(/before its first batch/);
    expect(
      reportBlock(
        { ...JOB, report: { available: false, expiresAt: 1_790_600_000 } },
        true,
      ),
    ).toMatch(/expired on .*kept for 7 days/);
  });
});

describe("campaignProblem", () => {
  const at = (
    e: unknown,
    action: Parameters<typeof campaignProblem>[1] = "job",
  ) => campaignProblem(e, action);

  it("puts a CSV or upload refusal at the file", () => {
    const invalid = at(
      refusal(400, { reason: "csv_invalid", csv: "token_column", line: 1 }),
    );
    expect(invalid.at).toBe("file");
    expect(invalid.message).toMatch(
      /The CSV was refused: a column reads like a device token.*\(line 1\)/,
    );
    expect(
      at(refusal(400, { reason: "csv_missing_columns", columns: ["name"] })),
    ).toEqual({
      at: "file",
      message: "The CSV has no column for {{name}}, which the template uses.",
    });
    for (const reason of [
      "upload_missing",
      "upload_size_mismatch",
      "upload_expired",
    ])
      expect(at(refusal(409, { reason }))).toMatchObject({
        at: "file",
        reupload: true,
      });
    // The browser's PUT to storage failed: an `ApiError` with this code.
    expect(
      at(Object.assign(new Error("x"), { status: 403, code: "upload_failed" })),
    ).toMatchObject({ at: "file" });
  });

  it("names the daily job limit as a limit", () => {
    const p = at(refusal(409, { limit: "push.jobsPerDay", value: 10 }));
    expect(p.at).toBe("limit");
    expect(p.message).toMatch(/all 10 jobs it may today.*00:00 UTC/);
  });

  it("has a sentence for each remaining reason", () => {
    const msg = (status: number, reason: string, extra = {}) =>
      at(refusal(status, { reason, ...extra })).message;
    expect(msg(409, "idempotency_key_reused")).toMatch(/other settings/);
    expect(msg(409, "push_upload_cap", { max: 20 })).toMatch(
      /holds 20 pending recipient files/,
    );
    // The cap is read from the answer, never assumed.
    expect(msg(409, "push_dry_run_cap", { max: 20 })).toMatch(
      /ran its 20 dry runs for today/,
    );
    expect(msg(409, "push_dry_run_cap", { max: 7 })).toMatch(
      /ran its 7 dry runs for today/,
    );
    expect(msg(409, "push_dry_run_cap")).toMatch(
      /ran all its dry runs for today/,
    );
    expect(msg(409, "push_not_registered")).toMatch(
      /neither a platform registration nor a team sender key/,
    );
    expect(msg(400, "push_payload_too_large")).toMatch(/over 4,096 bytes/);
    expect(
      at(refusal(400, { reason: "template_has_variables" }), "broadcast"),
    ).toMatchObject({ at: "template" });
    expect(
      at(refusal(409, { reason: "push_template_name_taken" }), "template").at,
    ).toBe("name");
    expect(
      at(refusal(409, { reason: "push_template_cap", max: 20 }), "template")
        .message,
    ).toMatch(/at most 20 templates/);
    expect(
      at(refusal(409, { reason: "report_not_ready" }), "report").message,
    ).toMatch(/not finished/);
    expect(
      at(refusal(409, { reason: "report_absent" }), "report").message,
    ).toMatch(/without a report/);
  });

  it("marks a 503 and the write slot as platform-side", () => {
    expect(at(refusal(503, { reason: "push_not_configured" }))).toMatchObject({
      at: "platform",
      message: expect.stringMatching(/not set up on this stage/) as string,
    });
    expect(
      at(refusal(503, undefined, "push sender unavailable")),
    ).toMatchObject({
      at: "platform",
      message: expect.stringMatching(/Nothing was sent/) as string,
    });
    expect(
      at(refusal(503, undefined, "push storage unavailable")),
    ).toMatchObject({
      at: "platform",
      message: expect.stringMatching(/no storage/) as string,
    });
    // Any other 503 is not blamed on the sender.
    const other = at(refusal(503, undefined, "channel secret cannot be read"));
    expect(other.at).toBe("platform");
    expect(other.message).toMatch(/could not serve this right now/);
    expect(other.message).not.toMatch(/Firebase project/);
    expect(at(refusal(429, { retryAfterMs: 500 }))).toMatchObject({
      at: "platform",
      message: expect.stringMatching(/Too many writes/) as string,
    });
  });

  it("reads the reason where the server sends one", () => {
    expect(
      at(refusal(503, { reason: "push_storage_unavailable" })).message,
    ).toMatch(/no storage/);
    expect(
      at(refusal(503, { reason: "push_sender_unavailable" })).message,
    ).toMatch(/no longer holds the channel's Firebase project/);
    expect(
      at(refusal(410, { reason: "channel_inactive" }), "report").message,
    ).toMatch(/expired or disabled/);
    expect(
      at(refusal(410, { reason: "report_expired" }), "report").message,
    ).toMatch(/report expired/);
    // The reason wins over what the message happens to say.
    expect(
      at(refusal(503, { reason: "push_sender_unavailable" }, "no storage here"))
        .message,
    ).toMatch(/Firebase project/);
    expect(
      at(refusal(410, { reason: "channel_inactive" }), "job").message,
    ).toMatch(/cannot send\. Extend it first/);
  });

  it("explains a 410, a 404 and keeps anything else", () => {
    expect(at(refusal(410)).message).toMatch(/expired or disabled/);
    expect(at(refusal(410), "report").message).toMatch(/report expired/);
    expect(at(refusal(404))).toMatchObject({ at: "template" });
    expect(at(refusal(400, undefined, "invalid body"))).toEqual({
      at: "form",
      message: "invalid body",
    });
  });
});
