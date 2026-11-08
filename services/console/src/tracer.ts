import { AppError, nowSec, randomHex, ulid, type Clock } from "@yyt/core";
import {
  TRACER_SORT_KEYS,
  type LimitsDb,
  type TracerDb,
  type TracerMeta,
  type TracerRow,
} from "@yyt/console-db";
import { defineRoute, json, type AnyRoute } from "@yyt/http";
import { z } from "zod";
import { listParams, searchQuery } from "./list-query.js";
import { LIMITS, overLimit, resolveLimits } from "./limits.js";
import type { ConsoleIdentity } from "./identity.js";
import type { CrumbResolver, ResourceHistory } from "./resources.js";
import { resourceName, RESOURCE_NAME_MESSAGE } from "./team.js";
import { parseTracerUrl } from "./tracer-url.js";

export { parseTracerUrl };
import type { ResourceAccess, TeamAccessHelpers } from "./team-access.js";

/*
 * The console half of the tracer resource (docs/decisions.md *Debug
 * collector (`tracer`)* #5-#9, docs/tracer.md): create, list, read, rename,
 * rotate the write key and delete. tracer itself reads resource config through
 * the `/tr/*` routes (todo/85 P4b), never from MariaDB.
 *
 * The write key is a stated exception to "list/get responses omit secrets"
 * (decisions #6): it ships inside debug APKs, so every team member sees it and
 * it is protected only by rotation and per-resource quotas. A seatless
 * platform admin never sees it (decisions #8): the resource page is refused
 * like `secret: true`, and the project list leaves the key and the DSN out.
 */

/** Resources one project may hold without a grant: `tracer.resources` soft. */
export const TRACERS_PER_PROJECT_SOFT = LIMITS["tracer.resources"].soft;

/** The write key's bytes; hex-encoded it is 32 characters. */
const WRITE_KEY_BYTES = 16;

/**
 * `resourceName`, plus a `trc_` refusal: a name in the id shape could never be
 * addressed by name in the CLI. The gated `ID_LIKE` commit (todo/85 P4 note)
 * adds `trc` to the shared rule and makes this refinement redundant.
 */
const tracerName = resourceName.refine(
  (s) => !/^trc_/i.test(s),
  RESOURCE_NAME_MESSAGE,
);
const description = z.string().max(2000);

export const tracerCreateBody = z
  .object({ name: tracerName, description: description.optional() })
  .strict();

export const tracerPatchBody = z
  .object({
    name: tracerName.optional(),
    description: description.nullable().optional(),
  })
  .strict();

const tracersQuery = searchQuery(TRACER_SORT_KEYS).passthrough();

export interface TracerRoutesOptions {
  tracers: TracerDb;
  access: Pick<TeamAccessHelpers, "projectAccess" | "projectResource">;
  crumbs: CrumbResolver;
  history: ResourceHistory;
  /**
   * The stage's tracer base URL (`TRACER_URL`, SSM `tracer-url`), e.g.
   * `https://trace-dev.yyt.life`; empty until the container is reachable, and
   * the views then carry `dsn: null` and `readUrl: null` (the gateway `wsUrl`
   * rule, decisions #5).
   */
  tracerUrl: string;
  /** The project's `tracer.resources` grant, if any. */
  limits: Pick<LimitsDb, "listOverrides">;
  clock: Clock;
  /** The per-member slot every recorded write takes. */
  writeSlot: (id: ConsoleIdentity) => Promise<void>;
  audit: (
    actorId: string | null,
    action: string,
    target: string | null,
    detail?: unknown,
  ) => Promise<void>;
}

export function createTracerRoutes({
  tracers,
  access,
  crumbs,
  history,
  tracerUrl,
  limits,
  clock,
  writeSlot,
  audit,
}: TracerRoutesOptions): AnyRoute[] {
  const { projectAccess, projectResource } = access;
  const now = () => nowSec(clock);
  // A malformed SSM value must not take the console down: treat it as unset
  // (no DSN, no read URL) and say so in the log.
  let base: URL | undefined;
  try {
    base = parseTracerUrl(tracerUrl);
  } catch (err) {
    console.error(`tracer: ignoring TRACER_URL (${(err as Error).message})`);
  }
  const readUrl = base ? base.href.replace(/\/+$/, "") : null;
  // Sentry DSN shape: `https://<key>@<host>/<project id>`; every SDK in scope
  // accepts the non-numeric `trc_` id (decisions #5).
  const dsnOf = (t: TracerMeta) =>
    base ? `${base.protocol}//${t.writeKey}@${base.host}/${t.id}` : null;

  const tracerWith = (
    ctx: Parameters<typeof projectResource>[0] & { params: { id?: string } },
  ): Promise<ResourceAccess<"trc">> =>
    // Every route of one resource carries the write key or changes it, so a
    // seatless admin is refused on each (decisions #8).
    projectResource(
      ctx,
      { kind: "trc", id: ctx.params.id ?? "" },
      { secret: true },
    );

  async function views<T extends TracerMeta>(rows: T[], withKey: boolean) {
    const crumb = await crumbs(rows);
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      ...("description" in t ? { description: t.description } : {}),
      ...crumb(t),
      // Shown to every team member: the stated exception of decisions #6.
      ...(withKey ? { writeKey: t.writeKey, dsn: dsnOf(t) } : {}),
      readUrl,
      // The resource page says it: losing the volume loses the data (#4).
      noBackup: true,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));
  }
  const view = async (row: TracerRow) => (await views([row], true))[0]!;

  const tracerHistory = (
    row: TracerRow,
    actorId: string,
    action: "resource.create" | "resource.delete" | "resource.rotate",
  ) =>
    history(
      row.teamId,
      actorId,
      action,
      row.id,
      { resource: { kind: "trc", id: row.id, name: row.name } },
      now(),
    );

  async function requireFreeName(
    teamId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const hit = await tracers.findByName(teamId, name);
    if (hit && hit.id !== exceptId)
      throw new AppError(
        "conflict",
        `a tracer resource named "${name}" already exists in this team`,
      );
  }

  const noStore = (status: number, body: unknown) =>
    json(body, { status, noStore: true });

  return [
    defineRoute({
      method: "GET",
      path: "/projects/{prj}/tracers",
      auth: true,
      query: tracersQuery,
      handler: async (ctx) => {
        // Admin-visible like every resource list, minus the key and the DSN.
        const a = await projectAccess(ctx, ctx.params.prj!);
        const rows = await tracers.list({
          ...listParams(ctx.query),
          projectId: a.project.id,
        });
        return noStore(200, {
          tracers: await views(rows, a.standing !== "admin"),
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/projects/{prj}/tracers",
      auth: true,
      body: tracerCreateBody,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!, { secret: true });
        await writeSlot(a.id);
        const limit = await resolveLimits(
          limits,
          [{ kind: "project", id: a.project.id }],
          now(),
        );
        const maxPerProject = limit("tracer.resources");
        if ((await tracers.countResources(a.project.id)) >= maxPerProject)
          throw overLimit(
            "conflict",
            "tracer.resources",
            maxPerProject,
            `at most ${maxPerProject} tracer resources per project`,
          );
        await requireFreeName(a.team.id, ctx.body.name);
        const at = now();
        // Time-ordered, lower case: `TRACER_ID_RE`.
        const id = `trc_${ulid(at * 1000).toLowerCase()}`;
        await tracers.insert({
          id,
          teamId: a.team.id,
          projectId: a.project.id,
          name: ctx.body.name,
          description: ctx.body.description ?? null,
          writeKey: randomHex(WRITE_KEY_BYTES),
          ownerId: a.id.subject,
          at,
        });
        const row = await tracers.find(id);
        if (!row) throw new AppError("unavailable", "tracer resource vanished");
        // Never the key: the audit log outlives a rotation.
        await audit(a.id.subject, "tracer.create", id, {
          name: row.name,
          projectId: a.project.id,
        });
        await tracerHistory(row, a.id.subject, "resource.create");
        return noStore(201, await view(row));
      },
    }),
    {
      method: "GET",
      path: "/tracers/{id}",
      auth: true,
      handler: async (ctx) => {
        const a = await tracerWith(ctx);
        return noStore(200, await view(a.row));
      },
    },
    defineRoute({
      method: "PATCH",
      path: "/tracers/{id}",
      auth: true,
      body: tracerPatchBody,
      handler: async (ctx) => {
        const { id, row, team: t } = await tracerWith(ctx);
        await writeSlot(id);
        const patch: { name?: string; description?: string | null } = {};
        if (ctx.body.name !== undefined && ctx.body.name !== row.name) {
          await requireFreeName(t.id, ctx.body.name, row.id);
          patch.name = ctx.body.name;
        }
        if (ctx.body.description !== undefined)
          patch.description = ctx.body.description;
        if (!(await tracers.update(row.id, patch, now())))
          throw new AppError("not_found", "tracer resource not found");
        await audit(id.subject, "tracer.update", row.id, {
          fields: Object.keys(patch),
        });
        const after = await tracers.find(row.id);
        if (!after || after.deletedAt !== null)
          throw new AppError("not_found", "tracer resource not found");
        return noStore(200, await view(after));
      },
    }),
    {
      method: "POST",
      path: "/tracers/{id}/rotate-key",
      auth: true,
      handler: async (ctx) => {
        const { id, row } = await tracerWith(ctx);
        await writeSlot(id);
        // One UPDATE: the old key stops working as soon as tracer's 60 s
        // config cache turns over (decisions #6).
        if (
          !(await tracers.rotateWriteKey(
            row.id,
            randomHex(WRITE_KEY_BYTES),
            now(),
          ))
        )
          throw new AppError("not_found", "tracer resource not found");
        await audit(id.subject, "tracer.rotate", row.id, { name: row.name });
        await tracerHistory(row, id.subject, "resource.rotate");
        const after = await tracers.find(row.id);
        if (!after || after.deletedAt !== null)
          throw new AppError("not_found", "tracer resource not found");
        return noStore(200, await view(after));
      },
    },
    {
      method: "DELETE",
      path: "/tracers/{id}",
      auth: true,
      handler: async (ctx) => {
        const { id, row } = await tracerWith(ctx);
        await writeSlot(id);
        // A soft delete: it frees the name at once and cancels the resource's
        // limit rows; tracer purges the data only after the console reports
        // the resource deleted and a 7-day grace (decisions #9, P4b).
        if (!(await tracers.softDelete(row.id, now())))
          throw new AppError("not_found", "tracer resource not found");
        await audit(id.subject, "tracer.delete", row.id, { name: row.name });
        await tracerHistory(row, id.subject, "resource.delete");
        return undefined;
      },
    },
  ];
}
