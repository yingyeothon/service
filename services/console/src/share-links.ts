import {
  AppError,
  nowSec,
  randomHex,
  sha256Hex,
  ulid,
  type Clock,
} from "@yyt/core";
import type {
  CatalogAppRow,
  CatalogDb,
  ConsoleDb,
  ListingsDb,
  ShareLinkRow,
  TeamDb,
} from "@yyt/console-db";
import { defineRoute, json, type AnyRoute, type RouteContext } from "@yyt/http";
import QRCode from "qrcode";
import { z } from "zod";
import { catalogTopicOf } from "./catalog-push.js";
import { artifactView } from "./catalog.js";
import type { ConsoleIdentity } from "./identity.js";
import type { ResourceHistory } from "./resources.js";
import {
  renderSharePage,
  renderShareUnavailable,
  shareLang,
} from "./share-page.js";
import type { ResourceAccess, TeamAccessHelpers } from "./team-access.js";

/*
 * Catalog share links (docs/decisions.md *Catalog share links and install
 * bridge*): `/i/{appId}` for a public listing, `/i/shr_…` for a bearer token
 * a team mints for any of its apps. Both read exactly what a listing reads —
 * the newest artifact per platform and the app's name — and every case that
 * does not resolve answers the same, so the page never tells whether an app
 * exists. The token is a capability by design (rules/security.md): only its
 * SHA-256 is stored, the URL is returned once, and the request log records
 * the route pattern, never the path.
 */

export const SHARE_TOKEN = /^shr_[0-9a-f]{32}$/;
/** Live (unexpired, unrevoked) links per app (decision #2). */
export const SHARE_LINKS_PER_APP = 20;
export const SHARE_LINK_DAYS = [1, 7, 30] as const;
/** Rows stay this long past their expiry so the team's list still shows them. */
export const SHARE_LINK_PURGE_SEC = 30 * 86_400;
/** App ids are ULID-based; anything longer is not one and is not looked up. */
const REF_MAX = 64;

const label = z
  .string()
  .trim()
  .max(100)
  .refine((s) => !/\p{Cc}/u.test(s), "no control characters");

export const shareLinkBody = z
  .object({
    expiresInDays: z
      .union([z.literal(1), z.literal(7), z.literal(30)])
      .default(7),
    label: label.optional(),
  })
  .strict();

export interface ShareLinkRoutesOptions {
  listings: ListingsDb;
  catalog: CatalogDb;
  db: Pick<ConsoleDb, "findMembersByIds">;
  team: Pick<TeamDb, "findTeamNamesByIds">;
  access: Pick<TeamAccessHelpers, "projectResource">;
  history: ResourceHistory;
  writeSlot: (id: ConsoleIdentity) => Promise<void>;
  clock: Clock;
  audit: (
    actorId: string | null,
    action: string,
    target: string | null,
    detail?: unknown,
  ) => Promise<void>;
  stage: string;
  /** The console origin, `https://console-dev.yyt.life`: the share URLs' host. */
  baseUrl: string;
  /** The SPA root, `https://console-dev.yyt.life/ui`. */
  webUrl: string;
}

type PublicArtifact = Omit<ReturnType<typeof artifactView>, "objectKey">;

/** What a link grants, as the JSON twin and the page see it. */
export interface SharedApp {
  kind: "public" | "token";
  appId: string;
  appName: string;
  title: string;
  summary: string | null;
  teamName: string | null;
  expiresAt: number | null;
  topic: string | null;
  artifacts: PublicArtifact[];
}

const filenameOf = (a: PublicArtifact) =>
  decodeURIComponent(a.url.split("/").pop() ?? "");

/** The installer's rule: the newest Android build when it is an APK. */
export function installableAndroid(artifacts: PublicArtifact[]) {
  const a = artifacts.find((x) => x.platform === "android");
  return a && /\.apk$/i.test(filenameOf(a)) ? a : undefined;
}

/** The newest iOS build when it carries an ad-hoc install URL. */
export function installableIos(artifacts: PublicArtifact[]) {
  const a = artifacts.find((x) => x.platform === "ios");
  return a?.ios ? a : undefined;
}

export function createShareLinkRoutes({
  listings,
  catalog,
  db,
  team,
  access,
  history,
  writeSlot,
  clock,
  audit,
  stage,
  baseUrl,
  webUrl,
}: ShareLinkRoutesOptions): AnyRoute[] {
  const origin = baseUrl.replace(/\/+$/, "");
  const web = webUrl.replace(/\/+$/, "");
  const pageUrl = (ref: string) => `${origin}/i/${ref}`;

  /** The app behind `{app}` plus the caller's standing (404 hides the rest). */
  const appWith = (ctx: RouteContext): Promise<ResourceAccess<"app">> =>
    access.projectResource(ctx, { kind: "app", id: ctx.params.app! }, {});

  const linkHistory = (
    app: CatalogAppRow,
    actorId: string,
    action: "resource.create" | "resource.delete",
    linkId: string,
  ) =>
    history(
      app.teamId,
      actorId,
      action,
      app.id,
      { resource: { kind: "share_link", id: linkId, name: app.name } },
      nowSec(clock),
    );

  /**
   * Resolves a `ref` to what it grants, or `undefined` for every case the
   * page must not tell apart (decision #1).
   */
  async function resolve(ref: string): Promise<SharedApp | undefined> {
    if (ref.length > REF_MAX) return undefined;
    const now = nowSec(clock);
    let appId: string;
    let link: ShareLinkRow | undefined;
    if (ref.startsWith("shr_")) {
      if (!SHARE_TOKEN.test(ref)) return undefined;
      link = await listings.findShareLinkByHash(sha256Hex(ref));
      if (!link || link.revokedAt !== null || link.expiresAt <= now)
        return undefined;
      appId = link.appId;
    } else {
      appId = ref;
    }
    const listing = await listings.findListing(appId);
    if (link) {
      // A takedown hides the app's token links too (decision #2); with no
      // listing row the record is read on its own.
      if (listing ? listing.takedown : await listings.findTakedown(appId))
        return undefined;
    } else if (!listing || listing.audience !== "public" || listing.takedown)
      return undefined;
    const app = await catalog.findApp(appId);
    if (!app?.teamId) return undefined;
    const [names, artifacts] = await Promise.all([
      team.findTeamNamesByIds([app.teamId]),
      catalog.newestArtifactsPerPlatform([app.id]),
    ]);
    return {
      kind: link ? "token" : "public",
      appId: app.id,
      appName: app.name,
      title: listing?.title ?? app.name,
      // The listing's summary is publication text; an unlisted app's own
      // description is the team's, and a token link does not publish it.
      summary: listing?.summary ?? null,
      teamName: names[0]?.name ?? null,
      expiresAt: link ? link.expiresAt : null,
      topic: catalogTopicOf(stage, app.id) ?? null,
      artifacts: artifacts.map((a) => {
        const { objectKey: _k, ...v } = artifactView(a);
        return v;
      }),
    };
  }

  async function linkViews(rows: ShareLinkRow[]) {
    const ids = [...new Set(rows.flatMap((r) => r.createdBy ?? []))];
    const members = new Map(
      (ids.length ? await db.findMembersByIds(ids) : []).map((m) => [
        m.id,
        m.githubLogin,
      ]),
    );
    const now = nowSec(clock);
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      createdBy:
        r.createdBy === null ? null : (members.get(r.createdBy) ?? null),
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      revokedAt: r.revokedAt,
      live: r.revokedAt === null && r.expiresAt > now,
    }));
  }

  return [
    // ---- the team's side ---------------------------------------------------
    defineRoute({
      method: "POST",
      path: "/catalog/apps/{app}/share-links",
      auth: true,
      body: shareLinkBody,
      handler: async (ctx) => {
        const { id, row: app } = await appWith(ctx);
        await writeSlot(id);
        const now = nowSec(clock);
        // Count-then-insert: the write slot serialises one member, and two
        // members racing can overshoot the cap by one, which bounds nothing
        // that matters.
        const live = await listings.countLiveShareLinks(app.id, now);
        if (live >= SHARE_LINKS_PER_APP)
          throw new AppError(
            "conflict",
            `too many live share links (max ${SHARE_LINKS_PER_APP} per app)`,
            { details: { limit: SHARE_LINKS_PER_APP, value: live } },
          );
        const token = `shr_${randomHex(16)}`;
        const row = {
          id: `shl_${ulid()}`,
          appId: app.id,
          tokenHash: sha256Hex(token),
          label: ctx.body.label || null,
          createdBy: id.subject,
          createdAt: now,
          expiresAt: now + ctx.body.expiresInDays * 86_400,
        };
        await listings.insertShareLink(row);
        await audit(id.subject, "catalog.share.create", app.id, {
          linkId: row.id,
          expiresInDays: ctx.body.expiresInDays,
        });
        await linkHistory(app, id.subject, "resource.create", row.id);
        const [view] = await linkViews([{ ...row, revokedAt: null }]);
        // The only answer that ever carries the token.
        return json(
          { ...view, url: pageUrl(token) },
          { status: 201, noStore: true },
        );
      },
    }),
    {
      method: "GET",
      path: "/catalog/apps/{app}/share-links",
      auth: true,
      handler: async (ctx) => {
        const { row: app } = await appWith(ctx);
        const listing = await listings.findListing(app.id);
        return json(
          {
            links: await linkViews(await listings.listShareLinks(app.id)),
            // The permanent link, while the listing is public and standing.
            publicUrl:
              listing?.audience === "public" && !listing.takedown
                ? pageUrl(app.id)
                : null,
            limit: SHARE_LINKS_PER_APP,
          },
          { noStore: true },
        );
      },
    },
    {
      method: "DELETE",
      path: "/catalog/apps/{app}/share-links/{id}",
      auth: true,
      handler: async (ctx) => {
        const { id, row: app } = await appWith(ctx);
        await writeSlot(id);
        const r = await listings.revokeShareLink(
          app.id,
          ctx.params.id!,
          nowSec(clock),
        );
        if (r === "missing")
          throw new AppError("not_found", "share link not found");
        if (r === "revoked") {
          await audit(id.subject, "catalog.share.revoke", app.id, {
            linkId: ctx.params.id,
          });
          await linkHistory(app, id.subject, "resource.delete", ctx.params.id!);
        }
        return undefined;
      },
    },
    // ---- the recipient's side ----------------------------------------------
    {
      // The JSON twin the console app reads (decision #1).
      method: "GET",
      path: "/catalog/share/{ref}",
      auth: false,
      handler: async (ctx) => {
        const shared = await resolve(ctx.params.ref!);
        if (!shared) throw new AppError("not_found", "link not available");
        return json(shared, {
          noStore: true,
          headers: { "referrer-policy": "no-referrer" },
        });
      },
    },
    {
      // The bridge page (decision #5). Every failure is the same HTML page,
      // never a JSON error: a browser is on the other end.
      method: "GET",
      path: "/i/{ref}",
      auth: false,
      handler: async (ctx) => {
        const lang = shareLang(ctx.headers["accept-language"]);
        const ref = ctx.params.ref!;
        const shared = await resolve(ref);
        if (!shared) return renderShareUnavailable(lang);
        const url = pageUrl(ref);
        const android = installableAndroid(shared.artifacts);
        const ios = installableIos(shared.artifacts);
        return renderSharePage(
          {
            title: shared.title,
            summary: shared.summary,
            teamName: shared.teamName,
            expiresAt: shared.expiresAt,
            pageUrl: url,
            android: android
              ? { version: android.tags.version ?? null, url: android.url }
              : null,
            ios: ios?.ios
              ? { version: ios.tags.version ?? null, url: ios.ios.installUrl }
              : null,
            installerUrl: `${web}/installer`,
            qrSvg: await QRCode.toString(url, {
              type: "svg",
              margin: 1,
              errorCorrectionLevel: "M",
            }),
          },
          lang,
        );
      },
    },
  ];
}

/** Daily: drops links 30 days past their expiry (a revoked link included). */
export async function runShareLinkSweep({
  listings,
  clock,
  logger,
}: {
  listings: Pick<ListingsDb, "purgeShareLinks">;
  clock: Clock;
  logger: { info(msg: string, data?: Record<string, unknown>): void };
}): Promise<number> {
  const purged = await listings.purgeShareLinks(
    nowSec(clock) - SHARE_LINK_PURGE_SEC,
  );
  logger.info("share link sweep", { purged });
  return purged;
}
