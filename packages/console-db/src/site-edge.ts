import { AppError } from "@yyt/core";
import { run, type PrismaClient } from "./prisma.js";

export interface SiteEdgePolicy {
  prefix: string;
  payload: string;
}
/** Publisher callbacks must make at most two management attempts, with SDK retries disabled. */
export interface SiteEdgeDb {
  queue(
    policies: SiteEdgePolicy[],
    source?: {
      id: string;
      slug: string;
      accessJson?: string | null;
      activeDeployId?: string | null;
    },
  ): Promise<void>;
  pending(prefix: string, expected?: string): Promise<boolean>;
  flush(
    month: string,
    ceiling: number,
    publish: (rows: SiteEdgePolicy[]) => Promise<void>,
    prefix?: string,
  ): Promise<number>;
}
const MAX_BYTES = 4 * 1024 * 1024;
export function createSiteEdgeDb(prisma: PrismaClient): SiteEdgeDb {
  return {
    queue: (rows, source) =>
      run(() =>
        prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM site_edge_control WHERE id = 1 FOR UPDATE`;
          if (source) {
            await tx.$queryRaw`SELECT id FROM sites WHERE id = ${source.id} FOR UPDATE`;
            const live = await tx.sites.findUnique({
              where: { id: source.id },
            });
            if (
              !live ||
              live.slug !== source.slug ||
              (live.active_deploy_id ?? null) !==
                (source.activeDeployId ?? null) ||
              (live.access_json ?? null) !== (source.accessJson ?? null)
            )
              throw new AppError(
                "conflict",
                "site access changed; reload before synchronizing",
              );
          }
          for (const row of rows) {
            if (
              !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(row.prefix) ||
              Buffer.byteLength(row.payload) > 1024
            )
              throw new AppError("bad_request", "invalid site edge policy");
            const old = await tx.site_edge_policies.findUnique({
              where: { prefix: row.prefix },
            });
            if (old?.payload === row.payload) continue;
            await tx.site_edge_policies.upsert({
              where: { prefix: row.prefix },
              create: { ...row, pending: true },
              update: { payload: row.payload, pending: true },
            });
          }
          const [size] = await tx.$queryRaw<
            { bytes: bigint }[]
          >`SELECT COALESCE(SUM(OCTET_LENGTH(prefix) + OCTET_LENGTH(payload)), 0) AS bytes FROM site_edge_policies`;
          if (Number(size?.bytes ?? 0) > MAX_BYTES)
            throw new AppError("conflict", "site edge policy capacity reached");
        }),
      ),
    pending: (prefix, expected) =>
      run(async () => {
        const row = await prisma.site_edge_policies.findUnique({
          where: { prefix },
        });
        return (
          !row ||
          row.pending ||
          (expected !== undefined && row.payload !== expected)
        );
      }),
    flush: async (month, ceiling, publish, prefix) => {
      if (
        !(await run(() =>
          prisma.site_edge_policies.findFirst({
            where: { pending: true, ...(prefix ? { prefix } : {}) },
          }),
        ))
      )
        return 0;
      // Commit the reservation BEFORE making network calls. A rollback or a lost
      // response cannot refund a potentially billed attempt.
      await run(() =>
        prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM site_edge_control WHERE id = 1 FOR UPDATE`;
          const row = await tx.site_edge_control.findUniqueOrThrow({
            where: { id: 1 },
          });
          if (month < row.month)
            throw new AppError("conflict", "stale management budget month");
          const used = row.month === month ? row.used : 0;
          if (used + 2 > ceiling)
            throw new AppError(
              "conflict",
              "site edge monthly management budget exhausted",
            );
          await tx.site_edge_control.update({
            where: { id: 1 },
            data: { month, used: used + 2 },
          });
        }),
      );
      return run(() =>
        prisma.$transaction(
          async (tx) => {
            // Serialize publishers AND queue writers so an old snapshot cannot
            // overwrite a newer policy. No API retry sleeps inside this lock.
            await tx.$queryRaw`SELECT id FROM site_edge_control WHERE id = 1 FOR UPDATE`;
            const rows = await tx.site_edge_policies.findMany({
              where: { pending: true, ...(prefix ? { prefix } : {}) },
              take: 50,
              orderBy: { prefix: "asc" },
            });
            if (!rows.length) return 0;
            await publish(rows);
            await tx.site_edge_policies.updateMany({
              where: { prefix: { in: rows.map((r) => r.prefix) } },
              data: { pending: false },
            });
            return rows.length;
          },
          { timeout: 15000 },
        ),
      );
    },
  };
}
export function createMemorySiteEdgeDb(
  readSite?: (id: string) => Promise<
    | {
        slug: string;
        accessJson?: string | null;
        activeDeployId?: string | null;
      }
    | undefined
  >,
): SiteEdgeDb & {
  rows: Map<string, SiteEdgePolicy & { pending: boolean }>;
  used: () => number;
} {
  const rows = new Map<string, SiteEdgePolicy & { pending: boolean }>();
  let used = 0,
    month = "";
  let tail: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = tail.then(fn);
    tail = p.catch(() => undefined);
    return p;
  };
  return {
    rows,
    used: () => used,
    queue: (entries, source) =>
      locked(async () => {
        if (source) {
          if (!readSite) throw new Error("site reader required");
          const live = await readSite(source.id);
          if (
            !live ||
            live.slug !== source.slug ||
            (live.activeDeployId ?? null) !== (source.activeDeployId ?? null) ||
            (live.accessJson ?? null) !== (source.accessJson ?? null)
          )
            throw new AppError(
              "conflict",
              "site access changed; reload before synchronizing",
            );
        }
        const next = new Map(rows);
        for (const row of entries)
          next.set(row.prefix, { ...row, pending: true });
        if (
          [...next.values()].reduce(
            (n, r) => n + Buffer.byteLength(r.prefix + r.payload),
            0,
          ) > MAX_BYTES
        )
          throw new AppError("conflict", "site edge policy capacity reached");
        for (const row of entries)
          if (rows.get(row.prefix)?.payload !== row.payload)
            rows.set(row.prefix, { ...row, pending: true });
      }),
    pending: async (prefix, expected) => {
      const row = rows.get(prefix);
      return (
        !row ||
        row.pending ||
        (expected !== undefined && row.payload !== expected)
      );
    },
    flush: (m, ceiling, publish, prefix) =>
      locked(async () => {
        const pending = [...rows.values()]
          .filter((r) => r.pending && (!prefix || r.prefix === prefix))
          .sort((a, b) => a.prefix.localeCompare(b.prefix))
          .slice(0, 50);
        if (!pending.length) return 0;
        if (m < month)
          throw new AppError("conflict", "stale management budget month");
        if (month !== m) {
          month = m;
          used = 0;
        }
        if (used + 2 > ceiling)
          throw new AppError(
            "conflict",
            "site edge monthly management budget exhausted",
          );
        used += 2;
        await publish(pending);
        for (const r of pending) rows.set(r.prefix, { ...r, pending: false });
        return pending.length;
      }),
  };
}
