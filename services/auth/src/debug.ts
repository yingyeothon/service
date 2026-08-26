import { timingSafeEqual } from "node:crypto";
import {
  AppError,
  randomHex,
  nowSec,
  sha256Hex,
  ulid,
  type Clock,
} from "@yyt/core";
import type { ConsoleDb, OrgDb } from "@yyt/console-db";
import { defineRoute, type AnyRoute } from "@yyt/http";
import { signChannelToken } from "@yyt/jwt";
import { z } from "zod";
import type { ChannelStore } from "./channels.js";

export interface DebugRouteOptions {
  /** Callers must send `x-debug-key: <debugKey>`. */
  debugKey: string;
  /**
   * Writer handle on the console DB opened with the dev-only console
   * credentials (`DEBUG_MYSQL_*`); the console service is the real owner.
   */
  consoleDb: ConsoleDb;
  /**
   * Same dev credentials: every channel belongs to a project since todo/17,
   * so the seeder needs somewhere to put one. By default that is the `debug`
   * org's `smoke` project, created on first use.
   */
  orgDb: OrgDb;
  channels: ChannelStore;
  clock: Clock;
}

/** Where seeded channels live unless the caller names a project. */
export const DEBUG_ORG_NAME = "debug";
export const DEBUG_ORG_ID = "org_debug";
export const DEBUG_PROJECT_NAME = "smoke";
export const DEBUG_PROJECT_ID = "prj_debug";

const seedBody = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9_-]{3,40}$/)
      .optional(),
    audience: z.string().min(1).default("debug-game"),
    tokenTtlSec: z
      .number()
      .int()
      .positive()
      .max(7 * 86400)
      .default(86400),
    redirectAllowlist: z.array(z.string()).default([]),
    providers: z
      .object({
        github: z
          .object({ clientId: z.string(), clientSecret: z.string() })
          .optional(),
        google: z
          .object({ clientId: z.string(), clientSecret: z.string() })
          .optional(),
      })
      .default({}),
    ttlSec: z
      .number()
      .int()
      .positive()
      .default(7 * 86400),
    /** Seed into this project instead of the `debug` org's `smoke` project. */
    projectId: z
      .string()
      .regex(/^prj_[a-z0-9]{1,32}$/)
      .optional(),
  })
  .strict();

const mintBody = z
  .object({ channelId: z.string(), userId: z.string().min(1).max(64) })
  .strict();

/**
 * Dev-only hooks (`STAGE=dev` + `DEBUG_HOOKS=1`): seed an auth channel with a
 * known secret and mint a JWT without a provider round-trip. The handler
 * refuses to register these unless the guard passes, so `prod` never has them.
 */
export function createDebugRoutes({
  debugKey,
  consoleDb,
  orgDb,
  channels,
  clock,
}: DebugRouteOptions): AnyRoute[] {
  if (debugKey.length < 16)
    throw new Error("DEBUG_KEY must be at least 16 characters");
  const expected = Buffer.from(sha256Hex(debugKey), "hex");
  /**
   * The project a seeded channel goes into. An explicit `projectId` must
   * exist (404 otherwise — a smoke script that created its own org/project
   * passes it so its topic/match channels can reference the auth channel
   * from the same project). Without one, the `debug` org's `smoke` project
   * is found or created; both ids are fixed so concurrent seeds converge.
   */
  const placement = async (
    ownerId: string,
    projectId: string | undefined,
    now: number,
  ): Promise<{ orgId: string; projectId: string }> => {
    if (projectId) {
      const p = await orgDb.findProject(projectId);
      if (!p) throw new AppError("not_found", "project not found");
      return { orgId: p.orgId, projectId: p.id };
    }
    // By id, not by name: any dev member could create an org named `debug`
    // first and would then receive every seeded secret.
    let org = await orgDb.findOrg(DEBUG_ORG_ID);
    if (!org) {
      try {
        await orgDb.createOrg(
          {
            id: DEBUG_ORG_ID,
            name: DEBUG_ORG_NAME,
            createdBy: ownerId,
            createdAt: now,
          },
          now,
        );
      } catch (e) {
        // A concurrent seed won the race; re-read below.
        if (!(e instanceof AppError && e.code === "conflict")) throw e;
      }
      org = await orgDb.findOrg(DEBUG_ORG_ID);
      if (!org)
        throw new AppError(
          "conflict",
          `an organization named "${DEBUG_ORG_NAME}" exists that the seeder did not create`,
        );
    }
    let project = await orgDb.findProjectByName(org.id, DEBUG_PROJECT_NAME);
    if (!project) {
      try {
        await orgDb.createProject(
          { id: DEBUG_PROJECT_ID, orgId: org.id, name: DEBUG_PROJECT_NAME },
          { actorId: ownerId, at: now },
        );
      } catch (e) {
        if (!(e instanceof AppError && e.code === "conflict")) throw e;
      }
      project = await orgDb.findProjectByName(org.id, DEBUG_PROJECT_NAME);
      if (!project) throw new AppError("unavailable", "debug project vanished");
    }
    return { orgId: org.id, projectId: project.id };
  };
  const guard = (headers: Record<string, string | undefined>) => {
    const given = Buffer.from(sha256Hex(headers["x-debug-key"] ?? ""), "hex");
    if (!timingSafeEqual(given, expected))
      throw new AppError("unauthorized", "debug key required");
  };
  return [
    defineRoute({
      method: "POST",
      path: "/debug/channels",
      body: seedBody,
      handler: async ({ headers, body }) => {
        guard(headers);
        const b = body;
        const id = b.id ?? `dbg_${ulid().toLowerCase()}`;
        const secret = randomHex(32);
        const now = nowSec(clock);
        const ownerId = await consoleDb.upsertMember({
          id: "debug",
          githubId: 0,
          githubLogin: "debug",
          role: "admin",
          createdAt: now,
        });
        const { orgId, projectId } = await placement(ownerId, b.projectId, now);
        await consoleDb.insertChannel({
          id,
          kind: "auth",
          ownerId,
          orgId,
          projectId,
          name: `debug ${id}`,
          config: {
            audience: b.audience,
            tokenTtlSec: b.tokenTtlSec,
            redirectAllowlist: b.redirectAllowlist,
            providers: {
              ...(b.providers.github
                ? { github: { clientId: b.providers.github.clientId } }
                : {}),
              ...(b.providers.google
                ? { google: { clientId: b.providers.google.clientId } }
                : {}),
            },
          },
          secret: {
            secret,
            providers: {
              ...(b.providers.github
                ? {
                    github: { clientSecret: b.providers.github.clientSecret },
                  }
                : {}),
              ...(b.providers.google
                ? {
                    google: { clientSecret: b.providers.google.clientSecret },
                  }
                : {}),
            },
          },
          createdAt: now,
          expiresAt: now + b.ttlSec,
        });
        return {
          channelId: id,
          orgId,
          projectId,
          secret,
          audience: b.audience,
          expiresAt: now + b.ttlSec,
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/debug/token",
      body: mintBody,
      handler: async ({ headers, body }) => {
        guard(headers);
        const b = body;
        const ch = await channels.get(b.channelId);
        if (!ch) throw new AppError("not_found", "channel not found");
        const { token, exp } = await signChannelToken({
          secret: ch.secret.secret,
          channelId: ch.id,
          audience: ch.config.audience,
          userId: b.userId,
          ttlSec: ch.config.tokenTtlSec,
          clock,
        });
        return { jwt: token, userId: b.userId, exp };
      },
    }),
  ];
}
