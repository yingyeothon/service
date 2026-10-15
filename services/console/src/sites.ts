import type { createWriteSlot } from "./write-slot.js";
import {
  siteAccessState,
  siteAuthBody,
  siteSuspensionBody,
  type SiteAccess,
} from "./site-access.js";
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
  type LimitsDb,
  type SiteDeployLimits,
  type SiteDeployRow,
  type SiteNameRow,
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
  purgePrefix,
  sitePublicUrl,
  siteStagingKey,
  SLUG,
} from "./site-deploy.js";
import { SITE_UPLOAD_URL_TTL_SEC, type SiteStore } from "./site-store.js";
import {
  SITE_NAME_COUNT_SEC,
  SITE_NAMES_PER_TEAM,
  isReservedWord,
  siteHostUrl,
  siteNameIssue,
  type SiteMemberBudget,
} from "./site-domains.js";
import {
  formatLimitValue,
  overLimit,
  resolveLimits,
  type LimitKey,
} from "./limits.js";

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
/**
 * Lower-cased before the grammar: the stored name is byte-exact. A reserved
 * *word* passes here and is judged in the handler, where the identity is
 * known: a platform admin may claim it with a note (docs/decisions.md *Site
 * domains* §3); everything else reserved is refused for everyone.
 */
const siteDomain = z
  .string()
  .trim()
  .toLowerCase()
  .superRefine((v, c) => {
    const issue = siteNameIssue(v);
    if (issue && issue.kind !== "reserved-word")
      c.addIssue({ code: "custom", message: issue.message });
  });
/** Why a platform admin claims a reserved word; required for one, audited, never shown to members. */
const reservedNote = z.string().trim().min(1).max(2000);

export const siteCreateBody = z
  .object({ name: siteName, description: description.optional() })
  .strict();
export const sitePatchBody = z
  .object({
    name: siteName.optional(),
    description: description.nullable().optional(),
    /** A name claims (moving the site to it), `null` moves back to a random slug. */
    domain: siteDomain.nullable().optional(),
    reservedNote: reservedNote.optional(),
  })
  .strict();
/** The size is judged against the site's `site.zipBytes` in the handler (409 with `details`). */
export const siteDeployBody = z
  .object({ size: z.number().int().positive() })
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
  siteAccess?: SiteAccess;
  writeSlot?: ReturnType<typeof createWriteSlot>;
  sites: SitesDb;
  /** The `site.*` overrides (docs/decisions.md *Limit requests* #1). */
  limits: Pick<LimitsDb, "listOverrides">;
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
  /** `dev-g.yyt.life` when the stage has the per-site host (`{slug}.{suffix}`). */
  hostSuffix?: string;
  /** The per-team name slot (`createSiteNameSlot`). */
  nameSlot: (teamId: string) => Promise<void>;
  /** Per-member counters that outlive a deleted site (`createSiteMemberBudget`). */
  memberBudget: SiteMemberBudget;
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
  siteAccess,
  writeSlot,
  sites,
  limits,
  access,
  crumbs,
  history,
  store,
  invoke,
  cdnBaseUrl,
  hostSuffix,
  nameSlot,
  memberBudget,
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
    if (
      a.row.activeDeployId?.startsWith("sa_") &&
      a.row.updatedAt < nowSec(clock) - 60
    )
      await sites.releaseSite(a.row.id, a.row.activeDeployId, nowSec(clock));
    await heal(a.row.id);
    await healStaleDelete({ sites, clock, logger }, a.row);
    // Healing may have changed the row (claim released); re-read it.
    const row = await sites.findSite(a.row.id);
    if (!row) throw new AppError("not_found", "site not found");
    if (write && siteAccessState(row).suspended)
      throw new AppError("forbidden", "site is suspended");
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
    /** The `site.*` values commit pinned for the worker; null before m0030 and on a move. */
    limits: d.limits,
    error: d.error,
    createdBy: d.createdBy,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    expiresAt: d.expiresAt,
    /** `move`: a rename (docs/decisions.md *Site domains* §2), no zip. */
    kind: d.moveTo !== null ? ("move" as const) : ("upload" as const),
    moveTo: d.moveTo,
    moveFrom: d.moveFrom,
  });

  async function siteViews(rows: SiteRow[]) {
    const crumb = await crumbs(rows);
    // A busy site is held by an upload, a move or a delete; only a move has a
    // target worth showing. Busy sites are few, so one read each is fine.
    const moving = new Map<string, string>();
    for (const r of rows)
      if (r.activeDeployId !== null && r.activeDeployId !== SITE_DELETING) {
        const d = await sites.findDeploy(r.activeDeployId);
        if (d?.moveTo) moving.set(r.id, d.moveTo);
      }
    return Promise.all(
      rows.map(async (s) => ({
        access: siteAccess
          ? await siteAccess.view(s)
          : {
              mode: "public",
              username: null,
              suspended: false,
              sync: "submitted",
              available: false,
            },
        id: s.id,
        name: s.name,
        slug: s.slug,
        description: s.description,
        ...crumb(s),
        publicUrl: sitePublicUrl(cdnBaseUrl, s),
        basePath: `/${s.slug}/`,
        /** The claimed name, or null while the slug is random. */
        domain: s.named ? s.slug : null,
        /** The site's own origin (`{slug}.{suffix}`), null on a stage without it. */
        hostUrl: siteHostUrl(hostSuffix, s.slug),
        hostSuffix: hostSuffix ?? null,
        movingTo: moving.get(s.id) ?? null,
        currentDeployId: s.currentDeployId,
        /** A deploy (or a delete) holds the site; a new deploy is refused. */
        busy: s.activeDeployId !== null,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    );
  }
  const siteView = async (s: SiteRow) => (await siteViews([s]))[0]!;

  const noStore = (statusCode: number, body: unknown) =>
    json(body, { status: statusCode, noStore: true });

  /**
   * A random slug nothing uses or remembers: no site, no ledger row (a
   * prefix some team gave up stays that team's), and no object under it (the
   * dev bucket still holds hand-published games). A move in flight to the
   * same nine characters is caught by `renameSite` itself.
   */
  async function mintFreeSlug(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = mintSlug();
      // A random `…yyt…` or reserved word would read as the platform's host.
      if (siteNameIssue(candidate)) continue;
      if (await sites.findSiteBySlug(candidate)) continue;
      if (await sites.findSiteName(candidate)) continue;
      if (store && (await store.listKeys(`${candidate}/`)).length > 0) continue;
      return candidate;
    }
    throw new AppError("unavailable", "could not mint a slug");
  }

  /**
   * Claims `want` for the site (or a fresh random slug for `null`). A site
   * with files is moved by the worker (202); an empty one is renamed at once.
   * Both are a `site_deploys` row, so both spend the deploy budgets. The team
   * slot comes after validation (zod) and before any write.
   */
  async function rename(
    id: { subject: string },
    teamId: string,
    row: SiteRow,
    want: string | null,
    reserved?: { note: string },
  ): Promise<{ site: SiteRow; deploy?: SiteDeployRow }> {
    await nameSlot(teamId);
    if (row.activeDeployId !== null)
      throw new AppError("conflict", "a deploy is in flight; retry later");
    // Counted per member in Redis, not from rows a site delete cascades away.
    if (want !== null) await memberBudget.claim(id.subject);
    if (!SLUG.test(row.slug))
      throw new AppError("internal", "site has a malformed slug");
    const now = nowSec(clock);
    // Listed outside the transaction; `expectCurrentDeployId` catches a
    // deploy that goes live in between.
    const hasFiles =
      store !== undefined && (await store.listKeys(`${row.slug}/`)).length > 0;
    let target: string;
    if (want === null) target = await mintFreeSlug();
    else {
      target = want;
      // Objects under a prefix nobody recorded are a hand-published game:
      // remember it as nobody's, so the answer never changes.
      if (
        store &&
        !(await sites.findSiteName(target)) &&
        !(await sites.findSiteBySlug(target)) &&
        (await store.listKeys(`${target}/`)).length > 0
      ) {
        await sites.recordForeignPrefix(target, now);
        throw nameTaken();
      }
    }
    if (hasFiles && !invoke)
      throw new AppError("unavailable", "site extraction is not configured");
    await requireDeployBudget(row.id, id.subject, now);
    const input = {
      siteId: row.id,
      teamId,
      target,
      kind: want === null ? ("slug" as const) : ("name" as const),
      memberId: id.subject,
      at: now,
      cap: SITE_NAMES_PER_TEAM,
      countSince: now - SITE_NAME_COUNT_SEC,
      moveId: `sd_${ulid(now * 1000).toLowerCase()}`,
      hasFiles,
      expectSlug: row.slug,
      expectCurrentDeployId: row.currentDeployId,
    };
    let r = await sites.renameSite(input);
    if (r.status === "cleaning" && store) {
      // The team's own released prefix still has a tree (a failed move, a
      // cleanup the worker could not finish): empty it now rather than make
      // the team wait for the daily sweep. A failure answers `cleaning`.
      try {
        await purgePrefix(
          { sites, store, clock, logger },
          { name: target, releasedAt: r.releasedAt },
        );
        r = await sites.renameSite({
          ...input,
          moveId: `sd_${ulid(now * 1000 + 1).toLowerCase()}`,
        });
      } catch (e) {
        logger.warn("site name inline purge failed", {
          name: target,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    switch (r.status) {
      case "gone":
        throw new AppError("not_found", "site not found");
      case "busy":
        throw new AppError("conflict", "a deploy is in flight; retry later");
      case "taken":
        throw nameTaken();
      case "cleaning":
        throw new AppError(
          "conflict",
          "this name is still being cleaned up; retry later",
          { details: { reason: "domain_cleaning" } },
        );
      case "cap":
        throw new AppError(
          "conflict",
          `too many site names in this team (max ${SITE_NAMES_PER_TEAM} in use or released in the last 30 days)`,
          {
            details: {
              reason: "domain_cap",
              names: r.names.map((n) => ({
                name: n.name,
                releasedAt: n.releasedAt,
              })),
            },
          },
        );
      case "unchanged":
        return { site: r.site };
    }
    await audit(id.subject, "site.domain", row.id, {
      teamId,
      from: row.named ? row.slug : null,
      to: want,
      slugFrom: row.slug,
      slugTo: target,
      deployId: r.deploy.id,
      // A platform admin claiming a reserved word (*Site domains* §3): the
      // audit row is where the reason lives.
      ...(reserved ? { reserved: true, note: reserved.note } : {}),
    });
    if (r.status === "renamed") {
      await siteAccess?.publish(r.site);
      if (r.site.slug !== row.slug) await siteAccess?.block(row.slug);
      return { site: r.site };
    }
    try {
      await invoke!(r.deploy.id);
    } catch (e) {
      const at = nowSec(clock);
      const ended = await sites.finishDeploy({
        deployId: r.deploy.id,
        from: ["queued"],
        patch: { status: "failed", error: "invoke_failed" },
        at,
        releaseTarget: true,
      });
      // Nothing was copied: the target is empty, so stamp it at once (an
      // unserved name is free again, a served one needs no purge).
      if (ended.released)
        await sites.markSiteNamePurged(ended.released, at, at);
      logger.error("site move invoke failed", {
        deployId: r.deploy.id,
        message: e instanceof Error ? e.message : String(e),
      });
      throw new AppError("unavailable", "could not start the move", {
        cause: e,
      });
    }
    return { site: r.site, deploy: r.deploy };
  }

  const nameTaken = () =>
    new AppError("conflict", "this name is taken", {
      details: { reason: "domain_taken" },
    });

  /** The site's effective `site.*` values: an unexpired override, else the soft value. */
  async function siteLimits(
    siteId: string,
    now: number,
  ): Promise<SiteDeployLimits> {
    const limit = await resolveLimits(
      limits,
      [{ kind: "site", id: siteId }],
      now,
    );
    return {
      zipBytes: limit("site.zipBytes"),
      files: limit("site.files"),
      extractedBytes: limit("site.extractedBytes"),
    };
  }
  /** 409 naming the key and the value (`details: {limit, value}`), the asset routes' shape. */
  const overSiteLimit = (key: LimitKey, max: number) =>
    overLimit(
      "conflict",
      key,
      max,
      `zip is over this site's ${key} limit (${formatLimitValue(key, max)}); ask for more with a limit request`,
    );

  /** Per site and per member per hour; a move counts like an upload. */
  async function requireDeployBudget(
    siteId: string,
    memberId: string,
    now: number,
  ): Promise<void> {
    const recent = await sites.listDeploys(siteId, SITE_DEPLOYS_PER_HOUR);
    if (
      recent.length >= SITE_DEPLOYS_PER_HOUR &&
      recent[recent.length - 1]!.createdAt > now - 3600
    )
      throw new AppError(
        "rate_limited",
        `at most ${SITE_DEPLOYS_PER_HOUR} deploys per site per hour`,
      );
    // Per member across sites: a create/deploy/delete loop would
    // otherwise dodge the per-site cap. The rows go with a deleted site, so
    // the Redis counter is what actually holds; the row count stays as the
    // check that survives a Redis flush.
    if (
      (await sites.countDeploysBy(memberId, now - 3600)) >=
      SITE_DEPLOYS_PER_MEMBER_HOUR
    )
      throw new AppError(
        "rate_limited",
        `at most ${SITE_DEPLOYS_PER_MEMBER_HOUR} deploys per member per hour`,
      );
    await memberBudget.deploy(memberId);
  }

  const nameView = (n: SiteNameRow) => ({
    name: n.name,
    teamId: n.teamId,
    kind: n.kind,
    createdBy: n.createdBy,
    createdAt: n.createdAt,
    releasedAt: n.releasedAt,
    served: n.served,
    purgedAt: n.purgedAt,
  });
  const adminName = async (ctx: RouteContext) => {
    const name = (ctx.params.name ?? "").toLowerCase();
    if (!SLUG.test(name)) throw new AppError("not_found", "no such name");
    const row = await sites.findSiteName(name);
    if (!row) throw new AppError("not_found", "no such name");
    return row;
  };

  return [
    // Platform admin: the ledger row behind a name (docs/decisions.md *Site
    // domains* §5), and its release — the one way a recorded prefix (a
    // deleted team's, a squatter's, a hand-published game's) becomes
    // claimable again. The reason goes to the global audit log.
    {
      method: "GET",
      path: "/admin/site-names/{name}",
      auth: true,
      handler: async (ctx) => {
        requireRole(ctx, "admin");
        return nameView(await adminName(ctx));
      },
    },
    defineRoute({
      method: "POST",
      path: "/admin/site-names/{name}/release",
      auth: true,
      body: z.object({ reason: z.string().trim().min(1).max(500) }).strict(),
      handler: async (ctx) => {
        const id = requireRole(ctx, "admin");
        const row = await adminName(ctx);
        if (await sites.isPrefixBusy(row.name))
          throw new AppError("conflict", "a site uses this name");
        // Nothing may be left for the next owner's origin to serve.
        const s = requireStore();
        const keys = await s.listKeys(`${row.name}/`);
        if (keys.length > 0) {
          await s.deleteKeys(keys);
          await s.invalidate([`/${row.name}/*`]);
        }
        const r = await sites.dropSiteName(row.name);
        if (r === "in_use")
          throw new AppError("conflict", "a site uses this name");
        await audit(id.subject, "site_name.release", null, {
          ...nameView(row),
          objects: keys.length,
          reason: ctx.body.reason,
        });
        return undefined;
      },
    }),
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
        const slug = await mintFreeSlug();
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
        await siteAccess?.publish(s);
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
      method: "PUT",
      path: "/sites/{site}/auth",
      auth: true,
      body: siteAuthBody,
      handler: async (ctx) => {
        const { id, row } = await siteWith(ctx, true);
        if (!siteAccess || !hostSuffix)
          throw new AppError(
            "unavailable",
            "site authentication is not configured",
          );
        if (ctx.body.mode === "basic") {
          const grants = await limits.listOverrides(
            [{ kind: "site", id: row.id }],
            nowSec(clock),
          );
          if (!grants.some((g) => g.key === "site.basicAuth" && g.value === 1))
            throw new AppError(
              "forbidden",
              "request site.basicAuth and obtain platform admin approval first",
            );
        }
        await writeSlot?.(id);
        await siteAccess.configure(row, ctx.body);
        await audit(id.subject, "site.auth", row.id, { mode: ctx.body.mode });
        return noStore(202, await siteView((await sites.findSite(row.id))!));
      },
    }),
    defineRoute({
      method: "PUT",
      path: "/admin/sites/{site}/suspension",
      auth: true,
      body: siteSuspensionBody,
      handler: async (ctx) => {
        const admin = requireRole(ctx, "admin");
        const row = await sites.findSite(ctx.params.site!);
        if (!row) throw new AppError("not_found", "site not found");
        if (!siteAccess)
          throw new AppError(
            "unavailable",
            "site access control is not configured",
          );
        await writeSlot?.(admin);
        await siteAccess.suspend(row, ctx.body.suspended);
        await audit(admin.subject, "site.suspension", row.id, {
          suspended: ctx.body.suspended,
          reason: ctx.body.reason,
        });
        return noStore(202, await siteView((await sites.findSite(row.id))!));
      },
    }),
    defineRoute({
      method: "POST",
      path: "/sites/{site}/access-sync",
      auth: true,
      body: z.object({}).strict(),
      handler: async (ctx) => {
        const { id, row } = await siteWith(ctx, false);
        if (row.activeDeployId !== null)
          throw new AppError(
            "conflict",
            "site is busy; retry synchronization later",
          );
        if (id.role !== "admin")
          await projectResource(
            ctx,
            { kind: "site", id: row.id },
            { secret: true },
          );
        if (!siteAccess)
          throw new AppError(
            "unavailable",
            "site access control is not configured",
          );
        await writeSlot?.(id);
        await siteAccess.publish(
          row,
          row.slug,
          id.role === "admin" && siteAccessState(row).suspended,
        );
        return noStore(202, await siteView(row));
      },
    }),
    defineRoute({
      method: "PATCH",
      path: "/sites/{site}",
      auth: true,
      body: sitePatchBody,
      handler: async (ctx) => {
        const { id, row, team: o } = await siteWith(ctx, true);
        const patch: { name?: string; description?: string | null } = {};
        // Every check that can refuse comes before the domain moves; only a
        // team-name race between the check and the update can still answer
        // 409 after a rename.
        if (ctx.body.name !== undefined && ctx.body.name !== row.name) {
          await requireFreeName(o.id, ctx.body.name, row.id);
          patch.name = ctx.body.name;
        }
        if (ctx.body.description !== undefined)
          patch.description = ctx.body.description;
        const want = ctx.body.domain;
        const fields = Object.keys(patch);
        let moving: SiteDeployRow | undefined;
        // Only an idle site's own value is a no-op: while a move is in flight
        // "the current name" is about to change, so the request goes on to
        // the slot and the busy answer.
        const noop =
          row.activeDeployId === null && want === (row.named ? row.slug : null);
        if (want !== undefined && !noop) {
          // Reserved words are the platform's own page names (*Site domains*
          // §3): a platform admin claims one with a note, a member never; and
          // a site that holds one changes or gives it up only by an admin, so
          // the name cannot pass to a team's ordinary members.
          const claimingReserved = want !== null && isReservedWord(want);
          const holdsReserved = row.named && isReservedWord(row.slug);
          if (claimingReserved && id.role !== "admin")
            throw new AppError("bad_request", "this name is reserved");
          if (holdsReserved && id.role !== "admin")
            throw new AppError(
              "forbidden",
              "only a platform admin changes a reserved name",
            );
          if (claimingReserved && ctx.body.reservedNote === undefined)
            throw new AppError(
              "bad_request",
              "reservedNote is required to claim a reserved name",
            );
          moving = (
            await rename(
              id,
              o.id,
              row,
              want,
              claimingReserved ? { note: ctx.body.reservedNote! } : undefined,
            )
          ).deploy;
          fields.push("domain");
        }
        if (Object.keys(patch).length > 0 || fields.length === 0) {
          if (!(await sites.updateSite(row.id, patch, nowSec(clock))))
            throw new AppError("not_found", "site not found");
          await audit(id.subject, "site.update", row.id, {
            fields: Object.keys(patch),
          });
        }
        await siteHistory(row, id.subject, "resource.update", fields);
        const s = await sites.findSite(row.id);
        if (!s) throw new AppError("not_found", "site not found");
        // 202 while the worker moves the files; the client polls the site.
        return moving ? json(await siteView(s), { status: 202 }) : siteView(s);
      },
    }),
    {
      method: "DELETE",
      path: "/sites/{site}",
      auth: true,
      handler: async (ctx) => {
        const { id, row } = await siteWith(ctx, true);
        const now = nowSec(clock);
        // Checked before the claim, so a bad row never wedges the site.
        if (!SLUG.test(row.slug))
          throw new AppError("internal", "site has a malformed slug");
        // Same claim a deploy takes: the worker checks it before `live`, so
        // a deploy racing this delete ends `site_gone` instead of resurrecting
        // objects under a prefix nobody owns any more.
        if (!(await sites.claimSite(row.id, SITE_DELETING, now)))
          throw new AppError("conflict", "a deploy is in flight; retry later");
        // Re-read under the claim: a move that landed after the first read
        // changed the slug, and the prefix to empty is the current one.
        const held = await sites.findSite(row.id);
        if (!held) throw new AppError("not_found", "site not found");
        const slug = held.slug;
        if (!SLUG.test(slug)) {
          await sites.releaseSite(row.id, SITE_DELETING, nowSec(clock));
          throw new AppError("internal", "site has a malformed slug");
        }
        let served = false;
        let keys: string[] = [];
        try {
          const s = requireStore();
          await siteAccess?.block(slug);
          keys = await s.listKeys(`${slug}/`);
          served = keys.length > 0;
          if (keys.length > 0) await s.deleteKeys(keys);
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
        // The objects are gone: a CDN failure is a warning, never a reason
        // to hand the site back (a retry would find the prefix empty).
        let invalidated = keys.length === 0;
        if (keys.length > 0)
          invalidated = await store!
            .invalidate([`/${slug}/*`])
            .then(() => true)
            .catch((e: unknown) => {
              logger.warn("site delete invalidation failed", {
                siteId: row.id,
                message: e instanceof Error ? e.message : String(e),
              });
              return false;
            });
        // A prefix that served stays the team's (docs/decisions.md *Site
        // domains* §5); emptied and invalidated, it needs no purge.
        const at = nowSec(clock);
        if (!(await sites.deleteSite(row.id, at, served, slug)))
          throw new AppError("conflict", "the site changed; retry");
        if (invalidated) await sites.markSiteNamePurged(slug, at, at);
        await audit(id.subject, "site.delete", row.id, {
          name: row.name,
          slug,
          teamId: row.teamId,
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
        // The site's effective `site.zipBytes` (a grant, else the soft value):
        // refused with the key, so a client can point at `yyt limit request`.
        const caps = await siteLimits(row.id, now);
        if (ctx.body.size > caps.zipBytes)
          throw overSiteLimit("site.zipBytes", caps.zipBytes);
        // Grants, not commits: a loop of presigns is the same S3/CDN cost.
        await requireDeployBudget(row.id, id.subject, now);
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
        if (obj.contentLength <= 0 || obj.contentLength > deploy.zipBytes)
          throw new AppError("bad_request", "uploaded zip has a bad size");
        // Re-checked against the limits of *now* (a grant lowered after the
        // presign still refuses, as the asset routes do) and pinned on the
        // row: from here the worker judges the zip by these values alone.
        const caps = await siteLimits(row.id, now);
        if (obj.contentLength > caps.zipBytes)
          throw overSiteLimit("site.zipBytes", caps.zipBytes);
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
            { status: "queued", zipBytes: obj.contentLength, limits: caps },
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
