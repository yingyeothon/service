import "@aws-sdk/signature-v4a";
import { createHmac, randomBytes } from "node:crypto";
import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  UpdateKeysCommand,
} from "@aws-sdk/client-cloudfront-keyvaluestore";
import { AppError, type Clock } from "@yyt/core";
import type { SiteEdgeDb, SitesDb, SiteRow } from "@yyt/console-db";
import { z } from "zod";

const credential = z
  .object({
    username: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\x21-\x39\x3b-\x7e]+$/),
    password: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[\x20-\x7e]+$/),
  })
  .strict();
export const siteAuthBody = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("public") }).strict(),
  credential.extend({ mode: z.literal("basic") }),
]);
export const siteSuspensionBody = z
  .object({ suspended: z.boolean(), reason: z.string().trim().min(1).max(500) })
  .strict();
export interface SiteAccessState {
  mode: "public" | "basic";
  suspended: boolean;
  username?: string;
  salt?: string;
  digest?: string;
}
export function siteAccessState(
  row: Pick<SiteRow, "accessJson">,
): SiteAccessState {
  if (!row.accessJson) return { mode: "public", suspended: false };
  try {
    const v = JSON.parse(row.accessJson) as SiteAccessState;
    if (
      (v.mode !== "public" && v.mode !== "basic") ||
      typeof v.suspended !== "boolean" ||
      (v.mode === "basic" &&
        (!v.username ||
          !/^[a-f0-9]{32}$/.test(v.salt ?? "") ||
          !/^[a-f0-9]{64}$/.test(v.digest ?? "")))
    )
      throw new Error();
    return v;
  } catch {
    throw new AppError("unavailable", "invalid site access configuration");
  }
}
export function edgePolicy(state: SiteAccessState): string {
  return JSON.stringify(
    state.suspended
      ? { mode: "blocked" }
      : state.mode === "public"
        ? { mode: "public" }
        : {
            mode: "basic",
            username: state.username,
            salt: state.salt,
            digest: state.digest,
          },
  );
}
export interface SiteAccess {
  ready: boolean;
  view(row: SiteRow): Promise<{
    mode: "public" | "basic";
    username: string | null;
    suspended: boolean;
    sync: "pending" | "submitted";
    available: boolean;
  }>;
  configure(row: SiteRow, body: z.infer<typeof siteAuthBody>): Promise<void>;
  suspend(row: SiteRow, suspended: boolean): Promise<void>;
  publish(row: SiteRow, prefix?: string, emergency?: boolean): Promise<void>;
  block(prefix: string, emergency?: boolean): Promise<void>;
  flush(emergency?: boolean): Promise<number>;
}
export function createSiteAccess({
  sites,
  db,
  clock,
  pepper,
  stage,
  publish,
}: {
  sites: SitesDb;
  db: SiteEdgeDb;
  clock: Clock;
  pepper: string;
  stage: "dev" | "prod";
  publish: (rows: { prefix: string; payload: string }[]) => Promise<void>;
}): SiteAccess {
  const flush = (emergency = false, prefix?: string) =>
    db.flush(
      new Date(clock.now()).toISOString().slice(0, 7),
      stage === "dev" ? (emergency ? 100 : 90) : emergency ? 900 : 810,
      publish,
      prefix,
    );
  const queue = async (row: SiteRow, prefix = row.slug, emergency = false) => {
    await db.queue(
      [{ prefix, payload: edgePolicy(siteAccessState(row)) }],
      row,
    );
    await flush(emergency, prefix);
  };
  const mutate = async (
    row: SiteRow,
    change: (state: SiteAccessState) => SiteAccessState,
    emergency: boolean,
  ) => {
    const holder = `sa_${randomBytes(12).toString("hex")}`;
    if (
      !(await sites.claimSite(row.id, holder, Math.floor(clock.now() / 1000)))
    )
      throw new AppError("conflict", "site is busy; retry later");
    try {
      const held = await sites.findSite(row.id);
      if (!held) throw new AppError("not_found", "site not found");
      const next = {
        ...held,
        accessJson: JSON.stringify(change(siteAccessState(held))),
      };
      // Durable desired state precedes publication. Failure is visible as pending;
      // no retry can accidentally clear the last enforced authentication policy.
      await sites.updateSite(
        row.id,
        { accessJson: next.accessJson },
        Math.floor(clock.now() / 1000),
      );
      // Desired changes remain auditable even when publication fails. The view
      // compares desired payload with the outbox and exposes pending status.
      await queue(next, next.slug, emergency).catch(() => undefined);
    } finally {
      await sites.releaseSite(row.id, holder, Math.floor(clock.now() / 1000));
    }
  };
  return {
    ready: pepper.length >= 32,
    view: async (row) => {
      const state = siteAccessState(row);
      return {
        mode: state.mode,
        username: state.username ?? null,
        suspended: state.suspended,
        sync: (await db.pending(row.slug, edgePolicy(state)))
          ? "pending"
          : "submitted",
        available: pepper.length >= 32,
      };
    },
    configure: (row, body) =>
      mutate(
        row,
        (state) => {
          if (state.suspended)
            throw new AppError("forbidden", "site is suspended");
          if (body.mode === "public")
            return { mode: "public", suspended: false };
          if (pepper.length < 32)
            throw new AppError(
              "unavailable",
              "site authentication is not configured",
            );
          const salt = randomBytes(16).toString("hex");
          return {
            mode: "basic",
            suspended: false,
            username: body.username,
            salt,
            digest: createHmac("sha256", pepper)
              .update(JSON.stringify([salt, body.username, body.password]))
              .digest("hex"),
          };
        },
        false,
      ),
    suspend: (row, suspended) =>
      mutate(row, (state) => ({ ...state, suspended }), suspended),
    publish: queue,
    block: async (prefix, emergency = false) => {
      await db.queue([{ prefix, payload: '{"mode":"blocked"}' }]);
      await flush(emergency, prefix);
    },
    flush,
  };
}
export function createAwsSitePolicyPublisher(arn: string) {
  const client = new CloudFrontKeyValueStoreClient({
    region: "us-east-1",
    maxAttempts: 1,
  });
  return async (rows: { prefix: string; payload: string }[]) => {
    try {
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
    } catch {
      throw new AppError(
        "unavailable",
        "site edge policy synchronization pending; retry later",
      );
    }
  };
}
