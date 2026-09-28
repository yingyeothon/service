import { readFileSync } from "node:fs";
// A namespace import, never `{ createRequire }`: the esbuild banner
// (serverless.yml) already declares `createRequire` and `require` at the top
// of the bundle, and a second top-level binding is a SyntaxError at cold start.
import * as nodeModule from "node:module";
import { dirname, join } from "node:path";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomHex, sha256Hex } from "@yyt/core";
import { presignPutUrl, sha256Base64 } from "./s3-util.js";

/*
 * What the Lambda runtime's AWS SDK actually does with the S3 features the
 * live-bundle commit depends on (docs/decisions.md *Large asset uploads* #3).
 * The console bundles exclude `@aws-sdk/*`, so the deployed function runs the
 * runtime's copy, and an SDK that does not know an input member drops it
 * silently: an unconditional copy looks exactly like a conditional one that
 * happened to succeed. Only a request against the real bucket tells them
 * apart, so this runs behind a dev-only debug route and the asset smoke
 * asserts every check.
 */

/**
 * The installed version of a package, read from the `package.json` above its
 * entry point: `require("<pkg>/package.json")` fails for packages whose
 * `exports` map omits it. `null` when it cannot be resolved.
 */
export function packageVersion(name: string): string | null {
  try {
    const req = nodeModule.createRequire(import.meta.url);
    let dir = dirname(req.resolve(name));
    for (let i = 0; i < 8; i++) {
      try {
        const pkg = JSON.parse(
          readFileSync(join(dir, "package.json"), "utf8"),
        ) as { name?: string; version?: string };
        if (pkg.name === name) return pkg.version ?? null;
      } catch {
        // No package.json at this level; keep walking up.
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {
    // Not resolvable from here.
  }
  return null;
}

/** The S3 SDK packages the console uses, as the cold-start log reports them. */
export function s3SdkVersions(): Record<string, string | null> {
  return {
    clientS3: packageVersion("@aws-sdk/client-s3"),
    presigner: packageVersion("@aws-sdk/s3-request-presigner"),
  };
}

export interface ProbeCheck {
  name: string;
  expected: string;
  got: string;
  ok: boolean;
}

export interface S3ProbeResult {
  sdk: Record<string, string | null>;
  checks: ProbeCheck[];
  /** Outcomes S3 does not promise a single answer for; reported, not asserted. */
  observations: Record<string, string>;
}

/** HTTP status (or the error name when S3 gave none) of a failed call. */
function statusOf(e: unknown): string {
  const m = (e as { $metadata?: { httpStatusCode?: number } }).$metadata;
  const name = (e as { name?: string }).name ?? "error";
  return m?.httpStatusCode ? `${m.httpStatusCode} ${name}` : name;
}

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "200";
  } catch (e) {
    return statusOf(e);
  }
}

/** `<Code>` of an S3 XML error body, if any. */
function s3Code(text: string): string {
  return /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? "";
}

/**
 * Writes a handful of objects under `prefix` (a staging prefix the asset sweep
 * already cleans), exercises conditional copies and checksum-signed presigned
 * PUTs, and deletes what it wrote. Every check names what S3 should answer.
 */
export async function runS3Probe({
  client,
  bucket,
  prefix = `asset-uploads/probe-${randomHex(8)}/`,
  fetchFn = fetch,
}: {
  client: S3Client;
  bucket: string;
  prefix?: string;
  fetchFn?: typeof fetch;
}): Promise<S3ProbeResult> {
  const key = (n: string) => `${prefix}${n}`;
  const src = `/${bucket}/${key("src.json")}`;
  const checks: ProbeCheck[] = [];
  const observations: Record<string, string> = {};
  const check = (name: string, expected: string, got: string) =>
    checks.push({
      name,
      expected,
      got,
      ok: got === expected || got.startsWith(`${expected} `),
    });
  const copy = (
    dst: string,
    cond: { IfMatch?: string; IfNoneMatch?: string },
  ) =>
    client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: src,
        Key: key(dst),
        MetadataDirective: "REPLACE",
        ContentType: "application/json",
        CacheControl: "no-cache",
        ChecksumAlgorithm: "SHA256",
        ...cond,
      }),
    );
  const written = ["src.json", "dst.json", "fresh.json", "race.json"];
  const put = (n: string, body: string) =>
    client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key(n),
        Body: body,
        ContentType: "application/json",
      }),
    );
  try {
    await put("src.json", '{"probe":"a"}');
    const dst = await put("dst.json", '{"probe":"b"}');
    const dstEtag = dst.ETag ?? "";

    check(
      "copy If-None-Match:* onto an existing key",
      "412",
      await outcome(copy("dst.json", { IfNoneMatch: "*" })),
    );
    check(
      "copy If-Match with a wrong ETag",
      "412",
      await outcome(
        copy("dst.json", { IfMatch: '"00000000000000000000000000000000"' }),
      ),
    );
    check(
      "copy If-Match with the current ETag",
      "200",
      await outcome(copy("dst.json", { IfMatch: dstEtag })),
    );
    check(
      "copy If-None-Match:* onto a fresh key",
      "200",
      await outcome(copy("fresh.json", { IfNoneMatch: "*" })),
    );
    // The destination's own checksum, which a commit reads back to tell its
    // own lost copy from somebody else's object.
    const head = await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key("fresh.json"),
        ChecksumMode: "ENABLED",
      }),
    );
    check(
      "copied object carries the SHA-256 of its bytes",
      sha256Base64(sha256Hex('{"probe":"a"}')),
      head.ChecksumSHA256 ?? "none",
    );
    check("copied object's Cache-Control", "no-cache", head.CacheControl ?? "");

    // Two first writes at once: exactly one may win. The loser's answer is
    // 412, or 409 ConditionalRequestConflict while the winner is in flight.
    const race = await Promise.all([
      outcome(copy("race.json", { IfNoneMatch: "*" })),
      outcome(copy("race.json", { IfNoneMatch: "*" })),
    ]);
    observations.race = race.sort().join(", ");
    // What S3 answers an `If-Match` on a key that does not exist (the
    // memory fake answers 412): observed, so a change is visible.
    observations.ifMatchMissingKey = await outcome(
      copy("missing.json", { IfMatch: dstEtag }),
    );
    check(
      "concurrent first writes: one wins",
      "1",
      String(race.filter((r) => r === "200").length),
    );

    // A presigned PUT must not carry a checksum the uploader did not choose.
    const plain = new URL(
      await presignPutUrl(client, {
        bucket,
        key: key("plain.json"),
        contentType: "application/json",
        contentLength: 5,
        ttlSec: 300,
      }),
    );
    const stray = [...plain.searchParams.keys()].filter(
      (k) =>
        k.toLowerCase().startsWith("x-amz-checksum-") ||
        k.toLowerCase() === "x-amz-sdk-checksum-algorithm",
    );
    check(
      "plain presign has no checksum parameter",
      "none",
      stray.join(",") || "none",
    );

    // The SHA-256 signed as a header: S3 refuses other bytes of the same size.
    const good = "hello";
    const sha = sha256Hex(good);
    const signedUrl = await presignPutUrl(client, {
      bucket,
      key: key("signed.txt"),
      contentType: "text/plain; charset=utf-8",
      contentLength: 5,
      ttlSec: 300,
      sha256: sha,
    });
    written.push("signed.txt");
    const signedPut = async (body: string) => {
      const r = await fetchFn(signedUrl, {
        method: "PUT",
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-amz-checksum-sha256": sha256Base64(sha),
        },
        body,
      });
      const text = await r.text();
      return `${r.status}${s3Code(text) ? ` ${s3Code(text)}` : ""}`;
    };
    check(
      "signed checksum refuses other bytes",
      "400 BadDigest",
      await signedPut("hellx"),
    );
    check("signed checksum accepts its bytes", "200", await signedPut(good));
    check(
      "signed checksum is a signed header",
      "true",
      String(
        (new URL(signedUrl).searchParams.get("X-Amz-SignedHeaders") ?? "")
          .split(";")
          .includes("x-amz-checksum-sha256"),
      ),
    );

    // The presigner's default: the checksum hoisted into the query string.
    // Observed, not asserted — the design never relies on it.
    const hoisted = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucket,
        Key: key("hoisted.txt"),
        ContentType: "text/plain; charset=utf-8",
        ContentLength: 5,
        ChecksumSHA256: sha256Base64(sha),
      }),
      {
        expiresIn: 300,
        signableHeaders: new Set(["content-type", "content-length"]),
      },
    );
    written.push("hoisted.txt");
    const r = await fetchFn(hoisted, {
      method: "PUT",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "hellx",
    });
    const text = await r.text();
    observations.hoistedChecksumWrongBody = `${r.status}${s3Code(text) ? ` ${s3Code(text)}` : ""}`;
  } finally {
    await client
      .send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: written.map((n) => ({ Key: key(n) })) },
        }),
      )
      .then(
        (d) => {
          observations.cleanup = `deleted ${d.Deleted?.length ?? 0}, errors ${d.Errors?.length ?? 0}`;
        },
        (e: unknown) => {
          observations.cleanup = `failed: ${statusOf(e)}`;
        },
      );
  }
  return { sdk: s3SdkVersions(), checks, observations };
}
