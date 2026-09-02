import {
  AppError,
  nowSec,
  randomHex,
  ulid,
  type Clock,
  type Logger,
} from "@yyt/core";
import {
  DEPLOY_SORT_KEYS,
  SITE_SORT_KEYS,
  type SiteDeployRow,
  type SiteRow,
  type SitesDb,
} from "@yyt/console-db";
import { defineRoute, type AnyRoute, type RouteContext, json } from "@yyt/http";
import { z } from "zod";
import { listParams, listQuery } from "./list-query.js";
import { requireRole } from "./identity.js";
import type { TeamAccessHelpers, ResourceAccess } from "./team-access.js";
import { resourceName } from "./team.js";
import type { CrumbResolver, ResourceHistory } from "./resources.js";
import {
  healStaleDelete,
  healStaleDeploys,
  SITE_DELETING,
  SITE_DEPLOYS_PER_HOUR,
  SITE_DEPLOYS_PER_MEMBER_HOUR,
  SITE_MAX_ZIP_BYTES,
  sitePublicUrl,
  siteStagingKey,
  SLUG,
} from "./site-deploy.js";
import { SITE_UPLOAD_URL_TTL_SEC, type SiteStore } from "./site-store.js";

/**
 * Shown on the site page, the create form and in `yyt site` help — the one
 * rule that makes a shared origin acceptable (docs/decisions.md *Static
 * sites*, decision 1). Keep the three copies byte-identical.
 */
export const SITE_SHARED_ORIGIN_WARNING =
  "Every site on this host shares one origin: another site here can read this page, its storage and its in-memory state (same-origin frames). Never keep a credential (JWT, API token) in localStorage, sessionStorage or IndexedDB; use short-lived tokens minted per session and treat this host as untrusted.";

/** Newest deploys a site view / list answers. */
export const SITE_DEPLOY_LIST_LIMIT = 20;

const sitesQuery = listQuery(SITE_SORT_KEYS).passthrough();
const deploysQuery = listQuery(DEPLOY_SORT_KEYS).passthrough();
const SITE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const siteName = resourceName.refine(
  (s) => SITE_NAME.test(s),
  "letters, digits, _, - (max 64)",
);
const description = z.string().max(2000);

export const siteCreateBody = z
  .object({ name: siteName, description: description.optional() })
  .strict();
export const sitePatchBody = z
  .object({
    name: siteName.optional(),
    description: description.nullable().optional(),
  })
  .strict();
export const siteDeployBody = z
  .object({ size: z.number().int().positive().max(SITE_MAX_ZIP_BYTES) })
  .strict();

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Nine chars of `[a-z0-9]` from CSPRNG bytes (rejection-sampled, unbiased). */
export function mintSlug(random: () => number = defaultRandom): string {
  let out = "";
  while (out.length < 9) {
    const b = random();
    // 36 * 7 = 252: bytes ≥ 252 would bias the last few letters.
    if (b < 252) out += SLUG_ALPHABET[b % 36]!;
  }
  return out;
}
function defaultRandom(): number {
  return parseInt(randomHex(1), 16);
}

/** Async invoke of the worker; `undefined` = extraction not configured (503). */
export type SiteDeployInvoker = (deployId: string) => Promise<void>;

export interface SiteRoutesOptions {
  sites: SitesDb;
  access: Pick<
    TeamAccessHelpers,
    "projectAccess" | "projectResource" | "memberTeamIds"
  >;
  crumbs: CrumbResolver;
  history: ResourceHistory;
  /** `undefined` = site storage not configured (deploy routes answer 503). */
  store?: SiteStore;
  invoke?: SiteDeployInvoker;
  /** `https://dev-g.yyt.life` — the shared static host. */
  cdnBaseUrl: string;
  clock: Clock;
  logger: Logger;
  audit: (
    actorId: string | null,
    action: string,
    target: string | null,
    detail?: unknown,
  ) => Promise<void>;
}

export function createSiteRoutes({
  sites,
  access,
  crumbs,
  history,
  store,
  invoke,
  cdnBaseUrl,
  clock,
  logger,
  audit,
}: SiteRoutesOptions): AnyRoute[] {
  const { projectAccess, projectResource, memberTeamIds } = access;
  const heal = (siteId: string) =>
    healStaleDeploys({ sites, clock, logger }, siteId);

  function requireStore(): SiteStore {
    if (!store)
      throw new AppError("unavailable", "site storage is not configured");
    return store;
  }

  /** Content is public; management is team membership, like bundles. */
  async function siteWith(
    ctx: RouteContext,
    write: boolean,
  ): Promise<ResourceAccess<"site">> {
    const a = await projectResource(
      ctx,
      { kind: "site", id: ctx.params.site! },
      write ? { secret: true } : {},
    );
    await heal(a.row.id);
    await healStaleDelete({ sites, clock, logger }, a.row);
    // Healing may have changed the row (claim released); re-read it.
    const row = await sites.findSite(a.row.id);
    if (!row) throw new AppError("not_found", "site not found");
    return { ...a, row };
  }

  /** A deploy is addressed under its site; a mismatch is a 404 like a missing one. */
  async function deployWith(
    ctx: RouteContext,
    write: boolean,
  ): Promise<ResourceAccess<"site"> & { deploy: SiteDeployRow }> {
    const a = await siteWith(ctx, write);
    const deploy = await sites.findDeploy(ctx.params.deploy!);
    if (!deploy || deploy.siteId !== a.row.id)
      throw new AppError("not_found", "deploy not found");
    return { ...a, deploy };
  }

  async function requireFreeName(
    teamId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const hit = await sites.findSiteByName(teamId, name);
    if (hit && hit.id !== exceptId)
      throw new AppError(
        "conflict",
        `a site named "${name}" already exists in this team`,
      );
  }

  const siteHistory = (
    s: SiteRow,
    actorId: string,
    action: "resource.create" | "resource.update" | "resource.delete",
    fields?: string[],
  ) =>
    history(
      s.teamId,
      actorId,
      action,
      s.id,
      {
        resource: { kind: "site", id: s.id, name: s.name },
        ...(fields ? { fields } : {}),
      },
      nowSec(clock),
    );

  const deployView = (d: SiteDeployRow) => ({
    id: d.id,
    siteId: d.siteId,
    status: d.status,
    zipBytes: d.zipBytes,
    bytes: d.bytes,
    files: d.files,
    error: d.error,
    createdBy: d.createdBy,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    expiresAt: d.expiresAt,
  });

  async function siteViews(rows: SiteRow[]) {
    const crumb = await crumbs(rows);
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      description: s.description,
      ...crumb(s),
      publicUrl: sitePublicUrl(cdnBaseUrl, s),
      basePath: `/${s.slug}/`,
      currentDeployId: s.currentDeployId,
      /** A deploy (or a delete) holds the site; a new deploy is refused. */
      busy: s.activeDeployId !== null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  }
  const siteView = async (s: SiteRow) => (await siteViews([s]))[0]!;

  const noStore = (statusCode: number, body: unknown) =>
    json(body, { status: statusCode, noStore: true });

  return [
    {
      method: "GET",
      path: "/sites",
      auth: true,
      handler: async (ctx) => {
        const id = requireRole(ctx, "member");
        const teamIds = await memberTeamIds(id);
        if (teamIds.length === 0) return { sites: [] };
        return { sites: await siteViews(await sites.listSites({ teamIds })) };
      },
    },
    defineRoute({
      method: "GET",
      path: "/projects/{prj}/sites",
      auth: true,
      query: sitesQuery,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!);
        return {
          sites: await siteViews(
            await sites.listSites({
              ...listParams(ctx.query),
              projectId: a.project.id,
            }),
          ),
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/projects/{prj}/sites",
      auth: true,
      body: siteCreateBody,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!, { secret: true });
        await requireFreeName(a.team.id, ctx.body.name);
        const now = nowSec(clock);
        const siteId = `st_${randomHex(8)}`;
        // The slug is the prefix: a legacy object under it (the dev bucket
        // still holds hand-published games) would be served as this site.
        let slug = "";
        for (let attempt = 0; attempt < 5 && !slug; attempt++) {
          const candidate = mintSlug();
          if (await sites.findSiteBySlug(candidate)) continue;
          if (store && (await store.listKeys(`${candidate}/`)).length > 0)
            continue;
          slug = candidate;
        }
        if (!slug) throw new AppError("unavailable", "could not mint a slug");
        await sites.insertSite({
          id: siteId,
          name: ctx.body.name,
          slug,
          description: ctx.body.description ?? null,
          ownerId: a.id.subject,
          teamId: a.team.id,
          projectId: a.project.id,
          createdAt: now,
        });
        await audit(a.id.subject, "site.create", siteId, {
          name: ctx.body.name,
          slug,
          projectId: a.project.id,
        });
        const s = await sites.findSite(siteId);
        if (!s) throw new AppError("unavailable", "site vanished");
        await siteHistory(s, a.id.subject, "resource.create");
        return noStore(201, {
          ...(await siteView(s)),
          warning: SITE_SHARED_ORIGIN_WARNING,
        });
      },
    }),
    {
      method: "GET",
      path: "/sites/{site}",
      auth: true,
      handler: async (ctx) => {
        const { row } = await siteWith(ctx, false);
        const deploys = await sites.listDeploys(row.id, SITE_DEPLOY_LIST_LIMIT);
        const current = row.currentDeployId
          ? (deploys.find((d) => d.id === row.currentDeployId) ??
            (await sites.findDeploy(row.currentDeployId)))
          : undefined;
        return {
          ...(await siteView(row)),
          currentDeploy: current ? deployView(current) : null,
          deploys: deploys.map(deployView),
          warning: SITE_SHARED_ORIGIN_WARNING,
        };
      },
    },
    defineRoute({
      method: "PATCH",
      path: "/sites/{site}",
      auth: true,
      body: sitePatchBody,
      handler: async (ctx) => {
        const { id, row, team: o } = await siteWith(ctx, true);
        const patch: { name?: string; description?: string | null } = {};
        if (ctx.body.name !== undefined && ctx.body.name !== row.name) {
          await requireFreeName(o.id, ctx.body.name, row.id);
          patch.name = ctx.body.name;
        }
        if (ctx.body.description !== undefined)
          patch.description = ctx.body.description;
        if (!(await sites.updateSite(row.id, patch, nowSec(clock))))
          throw new AppError("not_found", "site not found");
        await audit(id.subject, "site.update", row.id, {
          fields: Object.keys(patch),
        });
        await siteHistory(
          row,
          id.subject,
          "resource.update",
          Object.keys(patch),
        );
        const s = await sites.findSite(row.id);
        if (!s) throw new AppError("not_found", "site not found");
        return siteView(s);
      },
    }),
    {
      method: "DELETE",
      path: "/sites/{site}",
      auth: true,
      handler: async (ctx) => {
        const { id, row } = await siteWith(ctx, true);
        const now = nowSec(clock);
        // Same claim a deploy takes: the worker checks it before `live`, so
        // a deploy racing this delete ends `site_gone` instead of resurrecting
        // objects under a prefix nobody owns any more.
        if (!(await sites.claimSite(row.id, SITE_DELETING, now)))
          throw new AppError("conflict", "a deploy is in flight; retry later");
        if (!SLUG.test(row.slug))
          throw new AppError("internal", "site has a malformed slug");
        try {
          const s = requireStore();
          const keys = await s.listKeys(`${row.slug}/`);
          if (keys.length > 0) {
            await s.deleteKeys(keys);
            // Edge copies of a removed site would otherwise live out the
            // TTL; an empty prefix has nothing cached and buys no path.
            await s.invalidate([`/${row.slug}/*`]);
          }
          // Rows cascade with the site; the staging zips they name would not.
          for (const d of await sites.listDeploys(
            row.id,
            SITE_DEPLOYS_PER_HOUR,
          ))
            if (d.status === "pending")
              await s.deleteZip(d.objectKey).catch(() => undefined);
        } catch (e) {
          await sites.releaseSite(row.id, SITE_DELETING, nowSec(clock));
          if (e instanceof AppError) throw e;
          throw new AppError("unavailable", "site storage error", { cause: e });
        }
        await sites.deleteSite(row.id);
        await audit(id.subject, "site.delete", row.id, {
          name: row.name,
          slug: row.slug,
        });
        await siteHistory(row, id.subject, "resource.delete");
        return undefined;
      },
    },
    defineRoute({
      method: "GET",
      path: "/sites/{site}/deploys",
      auth: true,
      query: deploysQuery,
      handler: async (ctx) => {
        const { row } = await siteWith(ctx, false);
        return {
          // The newest N (the repository cuts the window first), ordered as asked.
          deploys: (
            await sites.listDeploys(
              row.id,
              SITE_DEPLOY_LIST_LIMIT,
              listParams(ctx.query),
            )
          ).map(deployView),
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/sites/{site}/deploys",
      auth: true,
      body: siteDeployBody,
      handler: async (ctx) => {
        const { id, row } = await siteWith(ctx, true);
        const s = requireStore();
        if (!invoke)
          throw new AppError(
            "unavailable",
            "site extraction is not configured",
          );
        const now = nowSec(clock);
        // Grants, not commits: a loop of presigns is the same S3/CDN cost.
        const recent = await sites.listDeploys(row.id, SITE_DEPLOYS_PER_HOUR);
        if (
          recent.length >= SITE_DEPLOYS_PER_HOUR &&
          recent[recent.length - 1]!.createdAt > now - 3600
        )
          throw new AppError(
            "rate_limited",
            `at most ${SITE_DEPLOYS_PER_HOUR} deploys per site per hour`,
          );
        // Per member across sites: a create/deploy/delete loop would
        // otherwise dodge the per-site cap.
        if (
          (await sites.countDeploysBy(id.subject, now - 3600)) >=
          SITE_DEPLOYS_PER_MEMBER_HOUR
        )
          throw new AppError(
            "rate_limited",
            `at most ${SITE_DEPLOYS_PER_MEMBER_HOUR} deploys per member per hour`,
          );
        // Time-ordered: the deploy list sorts by (created_at, id).
        const deployId = `sd_${ulid(now * 1000).toLowerCase()}`;
        const key = siteStagingKey(deployId);
        await sites.insertDeploy({
          id: deployId,
          siteId: row.id,
          zipBytes: ctx.body.size,
          objectKey: key,
          createdBy: id.subject,
          createdAt: now,
          expiresAt: now + SITE_UPLOAD_URL_TTL_SEC,
        });
        const url = await s.presignZipPut({
          key,
          contentLength: ctx.body.size,
        });
        await audit(id.subject, "site.deploy.grant", row.id, {
          deployId,
          size: ctx.body.size,
        });
        return noStore(201, {
          deployId,
          url,
          method: "PUT",
          headers: {
            "content-type": "application/zip",
            "content-length": String(ctx.body.size),
          },
          expiresAt: now + SITE_UPLOAD_URL_TTL_SEC,
        });
      },
    }),
    {
      method: "GET",
      path: "/sites/{site}/deploys/{deploy}",
      auth: true,
      handler: async (ctx) => {
        const { deploy } = await deployWith(ctx, false);
        return deployView(deploy);
      },
    },
    {
      method: "POST",
      path: "/sites/{site}/deploys/{deploy}/commit",
      auth: true,
      handler: async (ctx) => {
        const { id, row, deploy } = await deployWith(ctx, true);
        const s = requireStore();
        if (!invoke)
          throw new AppError(
            "unavailable",
            "site extraction is not configured",
          );
        // Idempotent for a client that retries: the state it already reached.
        if (deploy.status === "queued" || deploy.status === "extracting")
          return noStore(202, deployView(deploy));
        if (deploy.status === "live") return deployView(deploy);
        if (deploy.status === "failed")
          throw new AppError("conflict", `deploy failed (${deploy.error})`);
        const now = nowSec(clock);
        if (now > deploy.expiresAt)
          throw new AppError(
            "conflict",
            "upload expired; request a new deploy",
          );
        const obj = await s.headZip(deploy.objectKey);
        if (!obj) throw new AppError("bad_request", "zip was not uploaded");
        if (
          obj.contentLength <= 0 ||
          obj.contentLength > SITE_MAX_ZIP_BYTES ||
          obj.contentLength > deploy.zipBytes
        )
          throw new AppError("bad_request", "uploaded zip has a bad size");
        if (
          obj.contentType !== undefined &&
          obj.contentType !== "application/zip"
        )
          throw new AppError("bad_request", "uploaded object is not a zip");
        // The claim on the site row is what serialises deploys; the status
        // move is what keeps a second commit of the same deploy from invoking
        // the worker twice.
        if (!(await sites.claimSite(row.id, deploy.id, now)))
          throw new AppError(
            "conflict",
            "another deploy is in flight for this site; wait for it",
          );
        if (
          !(await sites.transitionDeploy(
            deploy.id,
            "pending",
            { status: "queued", zipBytes: obj.contentLength },
            now,
          ))
        ) {
          // A concurrent commit of the same deploy won the transition and
          // holds the claim (re-entrant per deploy): do NOT release it here,
          // or the worker would run on an idle site.
          const again = await sites.findDeploy(deploy.id);
          if (
            again &&
            (again.status === "queued" || again.status === "extracting")
          )
            return noStore(202, deployView(again));
          if (again?.status === "live") return deployView(again);
          throw new AppError("conflict", "deploy is not pending");
        }
        try {
          await invoke(deploy.id);
        } catch (e) {
          // Nobody will pick it up: say so now rather than after the stale heal.
          await sites.transitionDeploy(
            deploy.id,
            "queued",
            { status: "failed", error: "invoke_failed" },
            nowSec(clock),
          );
          await sites.releaseSite(row.id, deploy.id, nowSec(clock));
          logger.error("site deploy invoke failed", {
            deployId: deploy.id,
            message: e instanceof Error ? e.message : String(e),
          });
          throw new AppError("unavailable", "could not start the deploy", {
            cause: e,
          });
        }
        await audit(id.subject, "site.deploy.commit", row.id, {
          deployId: deploy.id,
          zipBytes: obj.contentLength,
        });
        const queued = await sites.findDeploy(deploy.id);
        return noStore(202, deployView(queued ?? deploy));
      },
    },
  ];
}
