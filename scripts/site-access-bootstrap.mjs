#!/usr/bin/env node
// Explicit rollout: deploy disabled, seed policies, then enable and redeploy.
// Never prints identifiers, credentials, policy payloads or AWS error bodies.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import {
  createPrismaClient,
  mysqlOptionsFromEnv,
  createSitesDb,
  createSiteEdgeDb,
} from "../packages/console-db/dist/index.js";
process.env.AWS_PROFILE ??= "yyt";
const [stage, mode] = process.argv.slice(2);
if (
  !["dev", "prod"].includes(stage) ||
  !["seed", "enable", "check", "revert-check"].includes(mode)
)
  throw new Error(
    "usage: site-access-bootstrap.mjs <dev|prod> <seed|enable|check>",
  );
const aws = (args, input) =>
  JSON.parse(
    execFileSync(
      "aws",
      [...args, "--region", "ap-northeast-2", "--output", "json"],
      {
        encoding: "utf8",
        input,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, AWS_PROFILE: process.env.AWS_PROFILE ?? "yyt" },
      },
    ) || "{}",
  );
const parameter = (name) =>
  aws([
    "ssm",
    "get-parameter",
    "--name",
    `/yyt-service/${stage}/${name}`,
    "--with-decryption",
  ]).Parameter.Value;
const put = (name, value, type = "String") => {
  const dir = mkdtempSync(join(tmpdir(), "yyt-site-access-"));
  const file = join(dir, "input.json");
  try {
    writeFileSync(
      file,
      JSON.stringify({
        Name: `/yyt-service/${stage}/console/${name}`,
        Value: value,
        Type: type,
        Overwrite: true,
      }),
      { mode: 0o600 },
    );
    return aws(["ssm", "put-parameter", "--cli-input-json", `file://${file}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
for (const line of readFileSync(
  new URL(`../local/env/console.${stage}.env`, import.meta.url),
  "utf8",
).split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2];
}
const db = createPrismaClient(mysqlOptionsFromEnv());
try {
  const sites = createSitesDb(db),
    edge = createSiteEdgeDb(db);
  const all = await sites.listSites();
  if (mode === "check" || mode === "revert-check") {
    const sensitive = all.some(
      (s) =>
        s.accessJson &&
        (JSON.parse(s.accessJson).mode === "basic" ||
          JSON.parse(s.accessJson).suspended),
    );
    if (sensitive && mode === "revert-check")
      throw new Error("protected or suspended sites forbid public origins");
    if (sensitive && parameter("console/site-access-enabled") !== "true")
      throw new Error(
        "cannot disable edge enforcement while access policies exist",
      );
    if (
      sensitive &&
      !readFileSync(
        new URL("../services/console/serverless.yml", import.meta.url),
        "utf8",
      ).includes("SiteAccessStore:")
    )
      throw new Error("cannot remove edge enforcement");
    console.log("site access deployment preflight passed");
  } else if (mode === "enable") {
    for (const site of all) {
      if (await edge.pending(site.slug))
        throw new Error(
          "managed site policy is missing or pending; seed first",
        );
    }

    if (await db.site_edge_policies.count({ where: { pending: true } }))
      throw new Error("pending policies; seed first");
    if (!(await db.site_edge_policies.count()))
      throw new Error("no registered policies");
    let pepper;
    try {
      pepper = parameter("console/site-access-pepper");
    } catch (e) {
      if (!String(e.stderr).includes("ParameterNotFound"))
        throw new Error("cannot read site access key");
    }
    if (!pepper) {
      const backup = process.env.SITE_ACCESS_PEPPER;
      if (backup && !/^[a-f0-9]{64}$/.test(backup))
        throw new Error("invalid site access key backup");
      if (
        !backup &&
        all.some(
          (s) => s.accessJson && JSON.parse(s.accessJson).mode === "basic",
        )
      )
        throw new Error(
          "restore the existing pepper before enabling protected sites",
        );
      put(
        "site-access-pepper",
        backup ?? randomBytes(32).toString("hex"),
        "SecureString",
      );
    } else if (!/^[a-f0-9]{64}$/.test(pepper))
      throw new Error("invalid site access key; refusing rotation");
    put("site-access-enabled", "true");
    console.log(
      "activation configured; redeploy console before using authentication",
    );
  } else {
    const bucket = parameter("site-bucket");
    const prefixes = new Set(all.map((s) => s.slug));
    let token;
    do {
      const page = aws([
        "s3api",
        "list-objects-v2",
        "--bucket",
        bucket,
        "--delimiter",
        "/",
        ...(token ? ["--continuation-token", token] : []),
      ]);
      for (const p of page.CommonPrefixes ?? []) {
        const name = p.Prefix.slice(0, -1);
        if (!/^(?!.*--)[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(name))
          throw new Error(
            "legacy prefix outside supported grammar; review before activation",
          );
        prefixes.add(name);
      }
      token = page.NextContinuationToken;
    } while (token);
    const managed = new Map(all.map((s) => [s.slug, s]));
    for (const prefix of prefixes) {
      // Rerunning seed must never turn a tombstone into a public prefix.
      if (await db.site_edge_policies.findUnique({ where: { prefix } }))
        continue;
      const row = managed.get(prefix),
        access = row?.accessJson
          ? JSON.parse(row.accessJson)
          : { mode: "public" };
      await edge.queue([
        {
          prefix,
          payload: JSON.stringify(
            access.suspended ? { mode: "blocked" } : access,
          ),
        },
      ]);
    }
    const outputs = aws([
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      `yyt-console-${stage}`,
    ]).Stacks[0].Outputs;
    const arn = outputs.find(
      (o) => o.OutputKey === "SiteAccessStoreArn",
    )?.OutputValue;
    if (!arn) throw new Error("deploy the disabled infrastructure first");
    const require = createRequire(
      new URL("../services/console/package.json", import.meta.url),
    );
    require("@aws-sdk/signature-v4a");
    const {
      CloudFrontKeyValueStoreClient,
      DescribeKeyValueStoreCommand,
      UpdateKeysCommand,
    } = require("@aws-sdk/client-cloudfront-keyvaluestore");
    const client = new CloudFrontKeyValueStoreClient({
      region: "us-east-1",
      maxAttempts: 1,
    });
    let total = 0,
      n;
    do {
      n = await edge.flush(
        new Date().toISOString().slice(0, 7),
        stage === "dev" ? 90 : 810,
        async (rows) => {
          const d = await client.send(
            new DescribeKeyValueStoreCommand({ KvsARN: arn }),
            { abortSignal: AbortSignal.timeout(4000) },
          );
          await client.send(
            new UpdateKeysCommand({
              KvsARN: arn,
              IfMatch: d.ETag,
              Puts: rows.map((r) => ({ Key: r.prefix, Value: r.payload })),
            }),
            { abortSignal: AbortSignal.timeout(4000) },
          );
        },
      );
      total += n;
    } while (n);
    console.log(
      `registered ${prefixes.size} prefixes; submitted ${total} policies (propagation is asynchronous)`,
    );
  }
} catch (e) {
  console.error(
    e.code
      ? `site access operation failed (${e.code})`
      : "site access operation failed; inspect configuration and pending policy state locally",
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
