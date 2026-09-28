import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Golden §7-4/10/11 (`todo/18`): every Lambda function in this repository sets
// `reservedConcurrency`, because the sum is what keeps the self-hosted
// MariaDB/Redis connection budget bounded (`rules/data.md`). Review used to be
// the only guard; this test fails the build instead.

const root = join(import.meta.dirname, "..");

function stackFiles(): string[] {
  const out: string[] = [];
  for (const dir of ["services"]) {
    for (const name of readdirSync(join(root, dir))) {
      const file = join(root, dir, name, "serverless.yml");
      try {
        if (statSync(file).isFile()) out.push(file);
      } catch {
        /* not a stack */
      }
    }
  }
  return out.sort();
}

describe("serverless.yml invariants", () => {
  const files = stackFiles();

  it("finds every stack", () => {
    expect(files.map((f) => f.slice(root.length + 1))).toEqual([
      "services/auth/serverless.yml",
      "services/console/serverless.yml",
      "services/match/serverless.yml",
      "services/state/serverless.yml",
      "services/topic/serverless.yml",
    ]);
  });

  for (const file of files) {
    it(`${file.slice(root.length + 1)}: every function reserves concurrency`, () => {
      // CloudFormation tags (`!Sub`, `!Ref`, `!If`) are opaque here; silence the
      // resolver warnings, the shape checks only need the plain keys.
      const doc = parse(readFileSync(file, "utf8"), { logLevel: "silent" }) as {
        functions?: Record<string, Record<string, unknown>>;
      };
      const fns = doc.functions ?? {};
      expect(Object.keys(fns).length).toBeGreaterThan(0);
      for (const [name, fn] of Object.entries(fns)) {
        expect(fn.handler, `${name}.handler`).toBeTypeOf("string");
        expect(
          fn.reservedConcurrency,
          `${name}.reservedConcurrency`,
        ).toBeTypeOf("number");
        expect(fn.reservedConcurrency as number).toBeGreaterThan(0);
      }
    });
  }

  it("state: every SSM environment value has a default", () => {
    const yml = readFileSync(
      join(root, "services/state/serverless.yml"),
      "utf8",
    );
    // A `${ssm:…}` without a default is resolved at *deploy* time, so a stage
    // whose parameter does not exist yet cannot deploy the stack at all --
    // including a fix to a route that has nothing to do with the missing
    // value. `KV_KEK` is the one that invites the mistake, because the runtime
    // deliberately treats an empty value as "kv is not configured" and answers
    // 503 on `/kv/*` alone (`services/state/src/handler.ts`); dropping the
    // default would move that failure a layer up, where it takes `/s/*` with
    // it. The MySQL parameters are the deliberate exception: without them the
    // stack has nothing to serve.
    const optional = /\$\{ssm:[^}]*\/(kv-kek)\b[^}]*\}/g;
    for (const line of yml.split("\n")) {
      const m = optional.exec(line);
      optional.lastIndex = 0;
      if (!m) continue;
      expect(line, line.trim()).toMatch(/,\s*""\}\s*$/);
    }
    expect(yml).toContain('KV_KEK: ${ssm:${self:custom.ssm}/kv-kek, ""}');
  });

  it("console: the asset KEK reaches the api function only, with a default", () => {
    const yml = readFileSync(
      join(root, "services/console/serverless.yml"),
      "utf8",
    );
    // Same reasoning as `KV_KEK` above: a missing parameter must not block
    // the whole stack, and the runtime treats an empty value as "encrypted
    // bundles are not configured" (`services/console/src/asset-crypto.ts`).
    expect(yml).toContain('ASSET_KEK: ${ssm:${self:custom.ssm}/asset-kek, ""}');
    const doc = parse(yml, { logLevel: "silent" }) as {
      provider: { environment?: Record<string, unknown> };
      functions: Record<string, { environment?: Record<string, unknown> }>;
    };
    // The provider environment is inherited by every function, and only
    // `api` may hold the KEK (docs/decisions.md *Live and encrypted asset
    // bundles* #4).
    expect(doc.provider.environment?.ASSET_KEK).toBeUndefined();
    for (const [name, fn] of Object.entries(doc.functions))
      expect(fn.environment?.ASSET_KEK !== undefined, name).toBe(
        name === "api",
      );
  });

  it("console: the per-site host is opt-in and never needs a template literal", () => {
    const yml = readFileSync(
      join(root, "services/console/serverless.yml"),
      "utf8",
    );
    // The opt-in parameter keeps its default: without it every console
    // deploy fails on a stage whose owner has not set the certificate.
    expect(yml).toContain(
      'siteHostCertArn: ${ssm:${self:custom.stageSsm}/site-host-cert-arn, ""}',
    );
    const doc = parse(yml, { logLevel: "silent" }) as {
      resources: {
        Resources: Record<string, { Type: string; Condition?: string }>;
      };
    };
    const res = doc.resources.Resources;
    // What costs money or answers DNS exists only where the owner opted in.
    for (const name of [
      "SiteHostDistribution",
      "SiteHostDnsA",
      "SiteHostDnsAAAA",
    ])
      expect(res[name]?.Condition, name).toBe("HasSiteHost");
    // Serverless resolves `${…}` inside FunctionCode: the stage suffix is the
    // only variable the function may contain.
    const at = yml.indexOf(
      "FunctionCode: |",
      yml.indexOf("\n    SiteHostRequestFunction:\n"),
    );
    const code = yml.slice(at, yml.indexOf("\n    SiteHostCachePolicy:", at));
    expect(code.match(/\$\{[^}]*\}?/g)).toEqual([
      "${self:custom.siteHostSuffix.${self:custom.stage}",
    ]);
  });
  it("console: CloudFront reads the site bucket through origin access control, never with a header", () => {
    const yml = readFileSync(
      join(root, "services/console/serverless.yml"),
      "utf8",
    );
    // The Referer origin lock is gone (docs/decisions.md *CDN cost guard* §11).
    expect(yml).not.toMatch(/originSecret|origin-secret|OriginCustomHeaders/);
    type Resource = {
      Condition?: string;
      Properties: {
        OriginAccessControlConfig?: Record<string, string>;
        FunctionCode?: string;
        DistributionConfig?: {
          Origins: {
            Id: string;
            OriginAccessControlId?: unknown;
            S3OriginConfig?: unknown;
          }[];
        };
      };
    };
    const doc = parse(yml, { logLevel: "silent" }) as {
      resources: { Resources: Record<string, Resource> };
    };
    const res = doc.resources.Resources;
    // The hand-made path host and artifact CDN use it on every stage.
    expect(res.CdnOriginAccessControl?.Condition).toBeUndefined();
    expect(
      res.CdnOriginAccessControl?.Properties.OriginAccessControlConfig,
    ).toMatchObject({
      OriginAccessControlOriginType: "s3",
      SigningBehavior: "always",
      SigningProtocol: "sigv4",
    });
    const origin =
      res.SiteHostDistribution?.Properties.DistributionConfig?.Origins.find(
        (o) => o.Id === "site",
      );
    // `!GetAtt CdnOriginAccessControl.Id`, the tag dropped by the parser.
    expect(origin?.OriginAccessControlId).toBe("CdnOriginAccessControl.Id");
    expect(origin?.S3OriginConfig).toEqual({ OriginAccessIdentity: "" });
    // The functions scripts/origin-oac.sh attaches exist on every stage, and
    // a `${` in their code would be a Serverless variable.
    for (const name of ["PathHostRequestFunction", "ArtifactRequestFunction"]) {
      expect(res[name]?.Condition, name).toBeUndefined();
      expect(res[name]?.Properties.FunctionCode, name).toBeTypeOf("string");
      expect(res[name]?.Properties.FunctionCode, name).not.toContain("${");
    }
  });

  it("console: only the CDN guard's own role may update a distribution, and only the three it may disable", () => {
    const yml = readFileSync(
      join(root, "services/console/serverless.yml"),
      "utf8",
    );
    // Optional pointers keep their defaults, or a stage without them fails to deploy.
    expect(yml).toContain(
      'artifactDistributionId: ${ssm:${self:custom.stageSsm}/cdn-distribution-id, ""}',
    );
    expect(yml).toContain(
      'CDN_GUARD_CONSOLE: ${param:cdnGuardConsole, "alert"}',
    );
    type Statement = {
      Effect: string;
      Action: string | string[];
      Resource: unknown;
    };
    type Fn = {
      role?: string;
      environment?: Record<string, unknown>;
      events?: { schedule?: { rate: string; enabled: string } }[];
      iam?: unknown;
    };
    const doc = parse(yml, { logLevel: "silent" }) as {
      custom: Record<string, unknown>;
      provider: {
        environment: Record<string, unknown>;
        iam: { role: { statements: unknown[]; managedPolicies?: unknown } };
      };
      functions: Record<string, Fn>;
      resources: {
        Resources: Record<
          string,
          {
            Type: string;
            Properties: {
              Policies?: { PolicyDocument: { Statement: unknown[] } }[];
            };
          }
        >;
      };
    };
    // Tags are dropped by the parser: `!If [cond, statement, NoValue]` is an array.
    const flat = (list: unknown[]) =>
      list.map((s) =>
        Array.isArray(s)
          ? { condition: s[0] as string, ...(s[1] as Statement) }
          : { condition: undefined, ...(s as Statement) },
      );
    const actions = (s: Statement) => [s.Action].flat();

    // Scheduled on every stage: dev's distributions are public too.
    expect(doc.custom.cdnGuardEnabled).toEqual({ dev: true, prod: true });
    const guard = doc.functions.cdnGuard!;
    expect(guard.events?.[0]?.schedule).toEqual({
      rate: "rate(5 minutes)",
      enabled: "${self:custom.cdnGuardEnabled.${self:custom.stage}, false}",
    });

    // The shared role (and so `api`) can never switch a distribution off,
    // and no other function has a role of its own.
    // Wildcards included: `*`, `cloudfront:*` and `cloudfront:Update*` would all grant it.
    const grantsUpdate = (a: string) =>
      /^(\*|cloudfront:\*|cloudfront:Update[A-Za-z]*\*?)$/.test(a);
    for (const s of flat(doc.provider.iam.role.statements))
      for (const a of actions(s)) expect(a, a).not.toSatisfy(grantsUpdate);
    expect(doc.provider.iam.role.managedPolicies).toBeUndefined();
    for (const [name, fn] of Object.entries(doc.functions))
      if (name !== "cdnGuard") {
        expect(fn.role, name).toBeUndefined();
        expect(JSON.stringify(fn.iam ?? {}), name).not.toContain(
          "UpdateDistribution",
        );
      }

    // The guard's role names each distribution it may disable, each behind
    // the condition that the stage has it; never the console's.
    expect(guard.role).toBe("CdnGuardRole");
    const role = doc.resources.Resources.CdnGuardRole!;
    expect(role.Type).toBe("AWS::IAM::Role");
    const statements = flat(
      role.Properties.Policies!.flatMap((p) => p.PolicyDocument.Statement),
    );
    const cloudfront = statements.filter(
      (s) =>
        s.Effect === "Allow" &&
        actions(s).some((a) => a.startsWith("cloudfront:")),
    );
    expect(cloudfront.map((s) => s.condition).sort()).toEqual([
      "HasArtifactDistribution",
      "HasSiteDistribution",
      "HasSiteHost",
    ]);
    for (const s of cloudfront) {
      const resource = JSON.stringify(s.Resource);
      expect(resource).not.toContain("WebDistribution");
      expect(resource).not.toBe('"*"');
      expect(resource).toMatch(
        /artifactDistributionId|siteDistributionId|SiteHostDistribution/,
      );
    }
    // And an explicit Deny on the console's own, whatever the SSM ids say.
    expect(
      statements.some(
        (s) =>
          s.Effect === "Deny" &&
          actions(s).includes("cloudfront:UpdateDistribution") &&
          JSON.stringify(s.Resource).includes("WebDistribution"),
      ),
    ).toBe(true);
    for (const [name, r] of Object.entries(doc.resources.Resources))
      if (name !== "CdnGuardRole")
        expect(JSON.stringify(r), name).not.toContain("UpdateDistribution");

    // The artifact bucket grant carries what a multipart upload needs
    // beyond PutObject (docs/decisions.md *Large asset uploads*): without
    // these a sweep cannot abort billed parts, nor a commit list them.
    const artifactObjects = flat(doc.provider.iam.role.statements).find(
      (s) =>
        s.Effect === "Allow" &&
        JSON.stringify(s.Resource).includes("artifactBucket}/*"),
    );
    expect(artifactObjects).toBeDefined();
    expect(actions(artifactObjects!)).toEqual(
      expect.arrayContaining([
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts",
      ]),
    );

    // The distribution ids reach only the functions that need them.
    const guardEnv = guard.environment ?? {};
    for (const k of [
      "CDN_GUARD_CONSOLE",
      "CDN_GUARD_MODE",
      "CDN_GUARD_SCALE",
      "SITE_HOST_DISTRIBUTION_ID",
      "WEB_DISTRIBUTION_ID",
    ])
      expect(guardEnv, k).toHaveProperty(k);
    // The guard holds none of the provider's secrets.
    for (const k of [
      "MYSQL_PASSWORD",
      "REDIS_ACL_PASSWORD",
      "GITHUB_CLIENT_SECRET",
      "DEBUG_KEY",
      "GATEWAY_TOKEN",
    ])
      expect(guardEnv[k], k).toBe("");
    expect(Object.keys(doc.functions.expire?.environment ?? {}).sort()).toEqual(
      ["SITE_HOST_DISTRIBUTION_ID", "WEB_DISTRIBUTION_ID"],
    );
    expect(doc.provider.environment.SITE_HOST_DISTRIBUTION_ID).toBeUndefined();
    expect(doc.provider.environment.WEB_DISTRIBUTION_ID).toBeUndefined();
  });
});
