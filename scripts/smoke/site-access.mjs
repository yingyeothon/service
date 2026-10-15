#!/usr/bin/env node
// Dev-only approval -> deploy -> edge authentication -> suspend/resume -> rename.
// YYT_DEBUG_KEY is read from the environment, never printed or sent in argv.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  asUser,
  createChecker,
  debugLogin,
  jsonClient,
  sleep,
} from "./_lib.mjs";
import { ensureTeam } from "./_team.mjs";
const base = "https://console-dev.yyt.life";
if (!process.env.YYT_DEBUG_KEY) throw new Error("YYT_DEBUG_KEY is required");
const { check, finish } = createChecker(),
  call = jsonClient({ base, redirect: "manual" }),
  as = asUser(base);
const login = debugLogin(call, base, process.env.YYT_DEBUG_KEY, check);
const member = await login("smoke-access-member", "member", -2461),
  admin = await login("smoke-access-admin", "admin", -2462);
const team = await ensureTeam(call, base, as(member), "smoke-access", check);
const write = async (path, body, user = member, method = "POST") => {
  await sleep(600);
  return call(path, { method, headers: as(user), body });
};
const password = randomBytes(24).toString("hex");
const auth = "Basic " + Buffer.from("viewer:" + password).toString("base64");
let id;
async function edge(url, status, authorization) {
  for (let i = 0; i < 45; i++) {
    const r = await fetch(url, {
      redirect: "manual",
      headers: authorization ? { authorization } : {},
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === status) return r;
    await sleep(2000);
  }
  throw new Error(`edge did not reach expected status ${status}`);
}
try {
  let r = await write(`/projects/${team.prjId}/sites`, {
    name: `access-${Date.now().toString(36)}`,
  });
  check("create site", r.status === 201, String(r.status));
  if (r.status !== 201) throw new Error("create failed");
  id = r.body.id;
  let site = r.body;
  r = await write(
    `/sites/${id}/auth`,
    { mode: "basic", username: "viewer", password },
    member,
    "PUT",
  );
  check("unapproved enable denied", r.status === 403, String(r.status));
  r = await write("/limit-requests", {
    scope: `site:${id}`,
    key: "site.basicAuth",
    value: 1,
    reason: "dev access smoke",
  });
  check("request approval", r.status === 201, String(r.status));
  const request = r.body.id;
  r = await write(`/admin/limit-requests/${request}/approve`, {}, admin);
  check("admin approval", r.status === 200, String(r.status));
  r = await write(
    `/sites/${id}/auth`,
    { mode: "basic", username: "viewer", password },
    member,
    "PUT",
  );
  check(
    "configure authentication",
    r.status === 202 && r.body.access?.sync === "submitted",
    String(r.status),
  );
  const zip = execFileSync("python3", [
    "-c",
    'import io,zipfile,sys\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w") as z:\n z.writestr("index.html","<h1>Private access smoke</h1>")\n z.writestr("asset.txt","private asset")\nsys.stdout.buffer.write(b.getvalue())',
  ]);
  r = await write(`/sites/${id}/deploys`, { size: zip.length });
  check("upload grant", r.status === 201, String(r.status));
  if (r.status !== 201) throw new Error("grant failed");
  const grant = r.body;
  const upload = await fetch(grant.url, {
    method: "PUT",
    headers: grant.headers,
    body: zip,
  });
  check("upload", upload.ok, String(upload.status));
  r = await write(`/sites/${id}/deploys/${grant.deployId}/commit`, undefined);
  check("queue deploy", r.status === 202, String(r.status));
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    r = await call(`/sites/${id}/deploys/${grant.deployId}`, {
      headers: as(member),
    });
    if (!["queued", "extracting"].includes(r.body.status)) break;
  }
  check("deploy live", r.body.status === "live", r.body.error ?? "");
  await edge(site.hostUrl, 401);
  check("anonymous host challenged", true);
  const good = await edge(site.hostUrl, 200, auth);
  check(
    "correct credentials serve content",
    (await good.text()).includes("Private access smoke"),
  );
  check(
    "browser cache is private",
    good.headers.get("cache-control") === "private, no-store",
  );
  await edge(site.hostUrl + "asset.txt", 401);
  check("assets also protected", true);
  await edge(site.publicUrl, 404, auth);
  check("shared path denied even with credentials", true);
  await edge(site.hostUrl, 401);
  check("warm cache remains protected", true);
  r = await write(
    `/admin/sites/${id}/suspension`,
    { suspended: true, reason: "dev emergency smoke" },
    admin,
    "PUT",
  );
  check("suspend", r.status === 202, String(r.status));
  await edge(site.hostUrl, 404, auth);
  check("suspension defeats valid credentials", true);
  r = await write(`/sites/${id}/auth`, { mode: "public" }, member, "PUT");
  check(
    "member cannot publish suspended site",
    r.status === 403,
    String(r.status),
  );
  r = await write(
    `/admin/sites/${id}/suspension`,
    { suspended: false, reason: "smoke complete" },
    admin,
    "PUT",
  );
  check(
    "resume preserves auth",
    r.status === 202 && r.body.access?.mode === "basic",
    String(r.status),
  );
  await edge(site.hostUrl, 200, auth);
  const old = site;
  r = await write(
    `/sites/${id}`,
    { domain: `access-${Date.now().toString(36)}` },
    member,
    "PATCH",
  );
  check("protected rename queued", r.status === 202, String(r.status));
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    r = await call(`/sites/${id}`, { headers: as(member) });
    if (!r.body.busy) break;
  }
  site = r.body;
  check("rename completed", site.slug !== old.slug);
  await edge(site.hostUrl, 200, auth);
  await edge(site.hostUrl, 401);
  await edge(old.hostUrl, 404, auth);
  check("renamed site protected and old alias denied", true);
  await edge(site.publicUrl, 404, auth);
  check("new shared path denied", true);
  r = await write(`/sites/${id}/auth`, { mode: "public" }, member, "PUT");
  check("explicit public transition", r.status === 202, String(r.status));
  await edge(site.hostUrl, 200);
  check("public transition serves anonymous visitors", true);
} catch {
  check("access smoke completed without an error", false);
} finally {
  if (id) {
    const r = await write(`/sites/${id}`, undefined, member, "DELETE");
    check("cleanup site", r.status === 204, String(r.status));
  }
}
finish("SITE ACCESS SMOKE ALL OK", (n) => `${n} SITE ACCESS CHECKS FAILED`);
