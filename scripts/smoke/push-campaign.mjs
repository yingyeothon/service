#!/usr/bin/env node
import { ensureTeam } from "./_team.mjs";
import {
  asUser,
  createChecker,
  debugLogin,
  exitOnCrash,
  jsonClient,
  mintToken,
  sleep,
} from "./_lib.mjs";
// Smoke test for push campaigns (todo/56 P2, docs/push.md *Campaigns*) on dev:
// templates, a recipient CSV through a presigned PUT, a dry run, a real job
// with its per-row report, idempotency, the two limits, a broadcast and the
// apiKey route family -- all on the console stack, with the `pushJob` worker
// doing the sends.
//
// The stage decides how far it goes, and the run prints which mode it was:
//   - "not configured": the pool's SSM path holds no project. The channel
//     create must answer 503 `push_not_configured`; the run stops and passes.
//   - "configured": the whole surface, against real FCM. The registered
//     tokens are made up, so FCM reports them gone: a recipient holding one
//     is `unregistered`, never `sent`, and no device receives anything. The
//     broadcast goes to a topic nobody subscribes to.
//   - "grant missing": the state account lacks its grant on `push_tokens`,
//     so no token can be registered; every recipient is then `no-token`.
//
// The package name is the same on every run (see `push.mjs` for why); it is
// not the one `push.mjs` uses, so the two scripts never hold each other's
// name. Override it with PUSH_SMOKE_PACKAGE for a one-off.
//
// Usage: scripts/smoke/push-campaign.mjs <docBaseUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>
// console and auth must be deployed on dev with `--param debugHooks=1`.
// Never prints tokens, keys, Firebase project ids, user ids or presigned URLs.
const [docBase, debugKey, authBase, consoleBase] = process.argv.slice(2);
if (!docBase || !debugKey || !authBase || !consoleBase) {
  console.error(
    "usage: push-campaign.mjs <docBaseUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>",
  );
  process.exit(2);
}
exitOnCrash();
const { check, finish } = createChecker();
// Every console write takes a 500 ms slot: per member on the member routes,
// per channel on the apiKey routes. One paced client serves both.
const con = jsonClient({ base: consoleBase, writeSlotMs: 550 });
const api = jsonClient({ base: docBase, timeoutMs: 30_000 });
const dbg = { "x-debug-key": debugKey };
const login = debugLogin(con, consoleBase, debugKey, check);
const as = asUser(consoleBase);
const stamp = Date.now().toString(36);
const pkg = process.env.PUSH_SMOKE_PACKAGE || "life.yyt.smoke.campaign";

const bearer = (token) => ({ authorization: `Bearer ${token}` });
// Only a status, an error code or a reason code ever reaches the log.
const why = (r) =>
  r.body?.error?.details?.reason ?? r.body?.error?.details?.limit ?? "";
const brief = (r) =>
  [r.status, r.body?.error?.code, why(r)].filter(Boolean).join(" ");

/** Five players of one channel. Ids are the shape `deriveUserId` produces. */
const [A, B, C, D, E] = ["a", "b", "c", "d", "e"].map((x) => x.repeat(32));
/** Made up: shaped like a token, registered with no device. */
const fakeToken = (n) => `smoke-${stamp}-${n}:${"x".repeat(120)}`;
/**
 * A and B hold a (made-up) token, C and D hold none, E's row lacks the
 * variable, and A appears twice. One quoted field with a comma and a quote.
 */
const CSV =
  "userId,name\r\n" +
  `${A},Ann\r\n` +
  `${B},"Bob, ""the"" second"\r\n` +
  `${C},Cid\r\n` +
  `${D},Dee\r\n` +
  `${E},\r\n` +
  `${A},again\r\n`;

let mode = "unknown";

async function demote(users) {
  try {
    for (const u of users)
      await con("/debug/login", {
        method: "POST",
        headers: dbg,
        body: { login: u.login, githubId: u.githubId, role: "pending" },
      });
  } catch (e) {
    check("demote the synthetic members", false, String(e));
  }
}

const owner = await login("smoke-campaign-owner", "member", -5611);
const admin = await login("smoke-campaign-admin", "admin", -5612);
if (!owner.cookie || !admin.cookie) {
  console.log("FAIL prerequisites (console debug hooks deployed?)");
  await demote([owner, admin]);
  process.exit(1);
}
let team;
/** Every channel this run created, the push channel first. */
const channels = [];
/** Limit overrides this run granted; the `finally` revokes them. */
const overrides = [];

const deleteChannel = (id) =>
  con(`/channels/${id}`, { method: "DELETE", headers: as(owner) });

async function removeLeftovers() {
  const list = await con(`/projects/${team.prjId}/channels?kind=push`, {
    headers: as(owner),
  });
  if (list.status !== 200) return;
  for (const c of list.body?.channels ?? []) {
    if (c.config?.packageName?.toLowerCase() !== pkg.toLowerCase()) continue;
    const r = await deleteChannel(c.id);
    check(`delete a leftover push channel ${c.id}`, r.status === 204, brief(r));
  }
}

async function cleanup() {
  // Never throws: an exception here would replace the real failure.
  try {
    for (const [channelId, key] of overrides) {
      const r = await con(
        `/admin/limit-overrides/channel/${channelId}/${key}`,
        { method: "DELETE", headers: as(admin), body: { note: "smoke" } },
      );
      check(`revoke the ${key} override`, r.status < 300 || r.status === 404);
    }
    for (const id of channels) {
      const r = await deleteChannel(id);
      check(
        `delete channel ${id}`,
        r.status === 204 || r.status === 404,
        brief(r),
      );
    }
  } catch (e) {
    check("cleanup", false, e instanceof Error ? e.message : String(e));
  } finally {
    await demote([owner, admin]);
  }
}

/** Both route families, as one function each: `(method, path, body)`. */
const memberOf = (id) => (method, path, body) =>
  con(`/channels/${id}/push${path}`, { method, headers: as(owner), body });
const keyOf =
  (id, key) =>
  (method, path, body, withKey = key) =>
    con(`/push-api/${id}${path}`, {
      method,
      headers: withKey ? bearer(withKey) : {},
      body,
    });

/** Issues an upload URL and PUTs the CSV there. Returns the upload id. */
async function upload(call, label, csv = CSV) {
  const bytes = Buffer.from(csv, "utf8");
  const issued = await call("POST", "/uploads", { size: bytes.length });
  check(
    `${label}: upload URL issued`,
    issued.status === 201 &&
      issued.body?.method === "PUT" &&
      issued.body?.headers?.["content-type"] === "text/csv",
    brief(issued),
  );
  if (issued.status !== 201) return undefined;
  // The URL is a bucket's, not the console's: no cookie goes with it.
  const put = await fetch(issued.body.url, {
    method: "PUT",
    headers: issued.body.headers,
    body: bytes,
  });
  check(`${label}: CSV uploaded`, put.status === 200, String(put.status));
  return issued.body.uploadId;
}

/** Polls a job until it is finished; the worker is asynchronous. */
async function settled(call, jobId, label) {
  let job;
  for (let i = 0; i < 90; i++) {
    const r = await call("GET", `/jobs/${jobId}`);
    job = r.body?.job;
    if (job?.status === "done" || job?.status === "failed") return job;
    await sleep(2000);
  }
  check(`${label}: the job finished within 3 minutes`, false, job?.status);
  return job ?? {};
}

/** The report's lines, through the presigned GET. */
async function reportLines(call, jobId) {
  const r = await call("GET", `/jobs/${jobId}/report`);
  if (r.status !== 200) return { status: r.status, lines: [] };
  const res = await fetch(r.body.url);
  const text = await res.text();
  return {
    status: res.status,
    disposition: res.headers.get("content-disposition") ?? "",
    lines: text.trimEnd().split("\n"),
    text,
  };
}

const counts = (j) => JSON.stringify(j?.counts ?? {});

async function run(id, apiKey, authId) {
  const m = memberOf(id);
  const k = keyOf(id, apiKey);

  /* --- device tokens (state stack) --- */

  const token = mintToken(api, authBase, debugKey, authId);
  const [ta, tb] = await Promise.all([token(A), token(B)]);
  check("mint player tokens", Boolean(ta && tb), "auth debug hooks deployed?");
  const put = (jwt, n) =>
    api(`/push/${id}/token`, {
      method: "PUT",
      headers: bearer(jwt),
      body: { token: fakeToken(n) },
    });
  const [pa, pb] = [await put(ta, 1), await put(tb, 2)];
  let holders = 2;
  if (pa.status === 503 || pb.status === 503) {
    mode = "grant missing";
    holders = 0;
    console.log(
      "     the state account lacks its grant on push_tokens: every recipient will be no-token",
    );
  } else
    check(
      "two made-up device tokens registered",
      pa.status === 204 && pb.status === 204,
      `${pa.status} ${pb.status}`,
    );

  /* --- templates --- */

  const created = await m("POST", "/templates", {
    name: `welcome-${stamp}`,
    title: "Hi {{name}}",
    body: "A gift for {{userId}}",
    data: { kind: "smoke", who: "{{name}}" },
  });
  const templateId = created.body?.id;
  check(
    "template created, its variables named",
    created.status === 201 &&
      JSON.stringify(created.body?.variables) === '["name","userId"]',
    brief(created),
  );
  const dupName = await m("POST", "/templates", {
    name: `WELCOME-${stamp}`,
    title: "x",
  });
  check(
    "the same name in another case: 409",
    dupName.status === 409 && why(dupName) === "push_template_name_taken",
    brief(dupName),
  );
  const reserved = await m("POST", "/templates", {
    name: `bad-${stamp}`,
    title: "x",
    data: { from: "y" },
  });
  check("a reserved data key: 400", reserved.status === 400, brief(reserved));
  const patched = await m("PATCH", `/templates/${templateId}`, {
    body: "A gift, {{name}}",
  });
  check(
    "template patched; the variables follow",
    patched.status === 200 &&
      JSON.stringify(patched.body?.variables) === '["name"]',
    brief(patched),
  );
  const extra = await m("POST", "/templates", {
    name: `extra-${stamp}`,
    title: "Hello {{name}} of tier {{tier}}",
  });
  const listed = await m("GET", "/templates");
  check(
    "the list holds both templates and names the cap of 20",
    listed.status === 200 &&
      listed.body?.max === 20 &&
      (listed.body?.templates ?? []).length === 2,
    String(listed.status),
  );
  const viaKey = await k("GET", "/templates");
  check("templates are member-only: 404 for the key", viaKey.status === 404);

  /* --- upload and dry run --- */

  const uploadId = await upload(m, "member");
  if (!templateId || !uploadId) return;
  const needsTier = await m("POST", "/jobs", {
    templateId: extra.body?.id,
    uploadId,
    idempotencyKey: `tier-${stamp}`,
    dryRun: true,
  });
  check(
    "a template naming a column the CSV lacks: 400 csv_missing_columns",
    needsTier.status === 400 &&
      why(needsTier) === "csv_missing_columns" &&
      JSON.stringify(needsTier.body?.error?.details?.columns) === '["tier"]',
    brief(needsTier),
  );
  const gone = await m("DELETE", `/templates/${extra.body?.id}`);
  check("template deleted", gone.status === 204, brief(gone));

  const dry = await m("POST", "/jobs", {
    templateId,
    uploadId,
    idempotencyKey: `dry-${stamp}`,
    dryRun: true,
  });
  check(
    "dry run accepted: 202, queued",
    dry.status === 202 &&
      dry.body?.created === true &&
      dry.body?.job?.dryRun === true,
    brief(dry),
  );
  const dryJob = await settled(m, dry.body?.job?.id, "dry run");
  const byKey = await k("GET", `/jobs?idempotencyKey=dry-${stamp}`);
  check(
    "the job is found by its idempotencyKey, through the apiKey",
    byKey.status === 200 &&
      byKey.body?.jobs?.length === 1 &&
      byKey.body.jobs[0].id === dry.body?.job?.id,
    brief(byKey),
  );
  const stranger = await keyOf("push_0000000000000000", apiKey)("GET", "/jobs");
  check(
    "an unknown channel answers like a wrong key: 401",
    stranger.status === 401,
    brief(stranger),
  );
  const spare = await upload(k, "spare");
  const dropped = await k("DELETE", `/uploads/${spare}`);
  check(
    "an unused upload is deleted: 204",
    dropped.status === 204,
    brief(dropped),
  );
  const dc = dryJob.counts ?? {};
  check(
    "dry run numbers: 6 rows, the token holders resolved, 2 skipped, nothing sent",
    dryJob.status === "done" &&
      dryJob.total === 6 &&
      dryJob.processed === 6 &&
      dc.resolved === holders &&
      dc.noToken === 4 - holders &&
      dc.missingVariables === 1 &&
      dc.duplicates === 1 &&
      dc.skipped === 2 &&
      dc.sent === 0,
    `${dryJob.status} ${dryJob.error ?? ""} ${counts(dryJob)}`,
  );

  /* --- the real job --- */

  const body = { templateId, uploadId, idempotencyKey: `real-${stamp}` };
  const real = await m("POST", "/jobs", body);
  check("job accepted: 202", real.status === 202, brief(real));
  const jobId = real.body?.job?.id;
  const again = await m("POST", "/jobs", body);
  check(
    "the same idempotencyKey again: 200 with the same job",
    again.status === 200 &&
      again.body?.created === false &&
      again.body?.job?.id === jobId,
    brief(again),
  );
  const differs = await m("POST", "/jobs", { ...body, priority: "high" });
  check(
    "the same key with other parameters: 409 idempotency_key_reused",
    differs.status === 409 && why(differs) === "idempotency_key_reused",
    brief(differs),
  );
  const job = await settled(m, jobId, "job");
  const jc = job.counts ?? {};
  // A made-up token is one FCM reports gone: its holder is `unregistered`.
  check(
    "job done: nobody reached, the made-up tokens reported gone, 2 skipped",
    job.status === "done" &&
      job.total === 6 &&
      jc.sent === 0 &&
      jc.unregistered + jc.failed === holders &&
      jc.noToken === 4 - holders &&
      jc.skipped === 2,
    `${job.status} ${job.error ?? ""} ${counts(job)}`,
  );
  check(
    "FCM called the made-up tokens unregistered",
    jc.unregistered === holders,
    counts(job),
  );
  const held = holders === 2 ? "unregistered," : "no-token,";
  const report = await reportLines(m, jobId);
  check(
    "the report: one line per row, in file order, no token in it",
    report.status === 200 &&
      report.disposition.includes("attachment") &&
      report.lines.length === 7 &&
      report.lines[0] === "userId,status,reason" &&
      (report.lines[1] === `${A},${held}` ||
        report.lines[1].startsWith(`${A},failed,`)) &&
      (report.lines[2] === `${B},${held}` ||
        report.lines[2].startsWith(`${B},failed,`)) &&
      report.lines[3] === `${C},no-token,` &&
      report.lines[4] === `${D},no-token,` &&
      report.lines[5] === `${E},skipped,missing-variable` &&
      report.lines[6] === `${A},skipped,duplicate` &&
      !report.text.includes("smoke-"),
    `${report.status} ${report.lines.length} line(s)`,
  );
  const view = await m("GET", `/jobs/${jobId}`);
  check(
    "the job view offers the report for 7 days",
    view.body?.job?.report?.available === true &&
      view.body.job.report.expiresAt - view.body.job.finishedAt === 604800,
    String(view.status),
  );

  /* --- limits --- */

  const limits = await con(`/limits?scope=channel:${id}`, {
    headers: as(owner),
  });
  const row = (key) => (limits.body?.limits ?? []).find((l) => l.key === key);
  const perDay = row("push.jobsPerDay");
  const perJob = row("push.recipientsPerJob");
  check(
    "limits: push.jobsPerDay 10 / 100 with today's job counted, push.recipientsPerJob 10,000 / 100,000",
    perDay?.soft === 10 &&
      perDay?.hard === 100 &&
      perDay?.usage === 1 &&
      perJob?.soft === 10_000 &&
      perJob?.hard === 100_000,
    `${limits.status} usage=${perDay?.usage}`,
  );
  const grant = async (key, value) => {
    const r = await con(`/admin/limit-overrides/channel/${id}/${key}`, {
      method: "PUT",
      headers: as(admin),
      body: { value, note: "push campaign smoke" },
    });
    if (r.status < 300) overrides.push([id, key]);
    return r;
  };
  // An admin's override may sit below the soft value: that is how this run
  // meets both limits with a six-row file.
  const tight = await grant("push.recipientsPerJob", 5);
  check(
    "admin sets push.recipientsPerJob to 5",
    tight.status < 300,
    brief(tight),
  );
  const big = await m("POST", "/jobs", {
    templateId,
    uploadId,
    idempotencyKey: `over-${stamp}`,
  });
  const bigJob = await settled(m, big.body?.job?.id, "over-limit job");
  check(
    "six rows against a limit of five: failed recipients_over_limit, nothing sent, the limit named",
    bigJob.status === "failed" &&
      bigJob.error === "recipients_over_limit" &&
      bigJob.errorDetails?.limit === "push.recipientsPerJob" &&
      bigJob.errorDetails?.value === 5 &&
      bigJob.processed === 0 &&
      bigJob.report === null,
    `${bigJob.status} ${bigJob.error ?? ""}`,
  );
  // Back to the soft value: the apiKey jobs below carry the same six rows.
  const roomy = await grant("push.recipientsPerJob", 10_000);
  check("admin lifts push.recipientsPerJob", roomy.status < 300, brief(roomy));
  // Two jobs were submitted today; a cap of two refuses the third.
  const capped = await grant("push.jobsPerDay", 2);
  check("admin sets push.jobsPerDay to 2", capped.status < 300, brief(capped));
  const third = await m("POST", "/jobs", {
    templateId,
    uploadId,
    idempotencyKey: `third-${stamp}`,
  });
  check(
    "the third job of the day: 409 with details.limit push.jobsPerDay",
    third.status === 409 &&
      third.body?.error?.details?.limit === "push.jobsPerDay" &&
      third.body?.error?.details?.value === 2,
    brief(third),
  );
  const thirdCast = await m("POST", "/broadcast", {
    title: "smoke",
    idempotencyKey: `cast-over-${stamp}`,
  });
  check(
    "a broadcast counts against the same limit: 409",
    thirdCast.status === 409 &&
      thirdCast.body?.error?.details?.limit === "push.jobsPerDay",
    brief(thirdCast),
  );
  const dryStill = await m("POST", "/jobs", {
    templateId,
    uploadId,
    idempotencyKey: `dry2-${stamp}`,
    dryRun: true,
  });
  check(
    "a dry run is not counted: 202 at the cap",
    dryStill.status === 202,
    brief(dryStill),
  );
  const lifted = await grant("push.jobsPerDay", 20);
  check("admin lifts push.jobsPerDay", lifted.status < 300, brief(lifted));

  /* --- broadcast --- */

  const cast = await m("POST", "/broadcast", {
    title: "Smoke broadcast",
    body: "to a topic nobody subscribes to",
    data: { kind: "smoke" },
    idempotencyKey: `cast-${stamp}`,
  });
  check(
    "broadcast accepted: 202",
    cast.status === 202 && cast.body?.job?.kind === "broadcast",
    brief(cast),
  );
  const castJob = await settled(m, cast.body?.job?.id, "broadcast");
  check(
    "broadcast done: one message for the channel's one project",
    castJob.status === "done" &&
      castJob.total === 1 &&
      castJob.counts?.sent === 1,
    `${castJob.status} ${castJob.error ?? ""} ${counts(castJob)}`,
  );
  const channel = await con(`/channels/${id}`, { headers: as(owner) });
  check(
    "the channel view names the topic the client subscribes to",
    channel.body?.topic === `yyt.push.${id}`,
    String(channel.status),
  );
  const withVar = await m("POST", "/broadcast", {
    title: "Hi {{name}}",
    idempotencyKey: `cast-var-${stamp}`,
  });
  check(
    "a broadcast with a variable: 400 template_has_variables",
    withVar.status === 400 && why(withVar) === "template_has_variables",
    brief(withVar),
  );

  /* --- the apiKey family --- */

  const noKey = await k("GET", "/jobs", undefined, "");
  const wrongKey = await k("GET", "/jobs", undefined, "0".repeat(64));
  const cookieOnly = await con(`/push-api/${id}/jobs`, { headers: as(owner) });
  check(
    "apiKey routes: 401 without a key, with a wrong key, and for a member's cookie",
    noKey.status === 401 &&
      wrongKey.status === 401 &&
      cookieOnly.status === 401,
    `${noKey.status} ${wrongKey.status} ${cookieOnly.status}`,
  );
  const keyUpload = await upload(k, "apiKey");
  const keyDry = await k("POST", "/jobs", {
    templateId,
    uploadId: keyUpload,
    idempotencyKey: `key-dry-${stamp}`,
    dryRun: true,
  });
  check(
    "apiKey: dry run accepted, author apikey",
    keyDry.status === 202 && keyDry.body?.job?.author === "apikey",
    brief(keyDry),
  );
  const keyJob = await settled(k, keyDry.body?.job?.id, "apiKey dry run");
  check(
    // The real job above deleted the made-up tokens FCM called unregistered,
    // so this run resolves nobody: the four sendable rows are all no-token.
    "apiKey: dry run done; the dead tokens are gone, so nobody resolves",
    keyJob.status === "done" &&
      keyJob.counts?.resolved === 0 &&
      keyJob.counts?.noToken === 4 &&
      keyJob.counts?.skipped === 2,
    `${keyJob.status} ${counts(keyJob)}`,
  );
  const keyReport = await reportLines(k, keyJob.id);
  check(
    "apiKey: the dry run's report downloads",
    keyReport.status === 200 && keyReport.lines.length === 7,
    String(keyReport.status),
  );
  const keyList = await k("GET", "/jobs?limit=2");
  check(
    "apiKey: the job list pages, newest first",
    keyList.status === 200 &&
      keyList.body?.jobs?.length === 2 &&
      keyList.body.jobs[0].id === keyJob.id &&
      typeof keyList.body.next === "string",
    String(keyList.status),
  );
  const keyCast = await k("POST", "/broadcast", {
    title: "Smoke broadcast",
    body: "to a topic nobody subscribes to",
    data: { kind: "smoke" },
    idempotencyKey: `cast-${stamp}`,
  });
  check(
    "apiKey: the member's broadcast key again is that broadcast, not a second one",
    keyCast.status === 200 && keyCast.body?.job?.id === cast.body?.job?.id,
    brief(keyCast),
  );
  const real2 = await k("POST", "/jobs", {
    templateId,
    uploadId: keyUpload,
    idempotencyKey: `key-real-${stamp}`,
  });
  const cancel = await k("POST", `/jobs/${real2.body?.job?.id}/cancel`);
  check(
    "apiKey: a job is submitted and its cancel is taken",
    real2.status === 202 && cancel.status === 200,
    `${brief(real2)} / ${brief(cancel)}`,
  );
  const ended = await settled(k, real2.body?.job?.id, "cancelled job");
  // The worker may have finished the six rows before the cancel landed.
  check(
    "the cancelled job ended: failed canceled, or done before the cancel",
    (ended.status === "failed" && ended.error === "canceled") ||
      ended.status === "done",
    `${ended.status} ${ended.error ?? ""}`,
  );
}

try {
  team = await ensureTeam(
    con,
    consoleBase,
    as(owner),
    "smoke-campaign-team",
    check,
  );
  await removeLeftovers();
  const auth = await con(`/projects/${team.prjId}/channels`, {
    method: "POST",
    headers: as(owner),
    body: {
      kind: "auth",
      name: `campaign smoke auth ${stamp}`,
      config: {
        audience: "push-campaign-smoke",
        tokenTtlSec: 3600,
        redirectAllowlist: [],
        providers: {},
      },
    },
  });
  check("create auth channel", auth.status === 201, brief(auth));
  if (auth.body?.id) channels.push(auth.body.id);
  const created = await con(`/projects/${team.prjId}/channels`, {
    method: "POST",
    headers: as(owner),
    body: {
      kind: "push",
      name: `campaign smoke ${stamp}`,
      config: { authChannelId: auth.body?.id, packageName: pkg },
    },
  });
  if (created.status === 201 && created.body?.id) {
    channels.unshift(created.body.id);
    mode = "configured";
    await run(created.body.id, created.body.apiKey, auth.body.id);
  } else if (created.status === 503 && why(created) === "push_not_configured") {
    mode = "not configured";
    check("the stage has no Firebase project: 503 push_not_configured", true);
    console.log(
      "     put a service-account key under SSM /yyt-service/<stage>/push/fcm/<slot> (docs/push.md, Adding a project) and run again within 10 minutes",
    );
  } else {
    mode = "create refused";
    check("create a push channel", false, brief(created));
  }
} finally {
  await cleanup();
}

console.log(`mode: ${mode}`);
finish("ALL OK", (n) => `${n} FAILED`);
