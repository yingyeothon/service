import {
  AppError,
  nowSec,
  randomHex,
  type Clock,
  type Logger,
} from "@yyt/core";
import type { TeamDb, VersionRow } from "@yyt/console-db";
import {
  LINKS_PER_VERSION,
  VERSIONS_PER_PROJECT,
  versionName,
} from "./team.js";

/** What a catalog commit reports about the project version it linked. */
export interface CommitVersion {
  id: string;
  name: string;
  linkId: string;
  /** The version row was created by this commit (not merely found). */
  created: boolean;
}

/**
 * The project version an artifact's `version` tag names: trimmed, with any
 * `+build` suffix removed (`1.0.7+8` → `1.0.7`; the build number belongs to
 * the artifact, not the version — the same rule the backfill script used),
 * and `undefined` when the rest is not a version name.
 */
export function versionNameFromTag(
  tag: string | undefined,
): string | undefined {
  if (tag === undefined) return undefined;
  const name = tag.trim().replace(/\+.*$/, "");
  return versionName.safeParse(name).success ? name : undefined;
}

/** The artifact a commit wants linked, and who is committing. */
export interface LinkTarget {
  projectId: string;
  appId: string;
  tag: string | undefined;
  artifactId: string;
  actorId: string;
}

const isConflict = (e: unknown): boolean =>
  e instanceof AppError && e.code === "conflict";

/**
 * Best-effort bookkeeping behind the catalog commit: the artifact's version
 * tag names a project version, created when missing, and the artifact is
 * linked to it. Every outcome that is not a link is `null` — a copied
 * artifact must never be failed by its own bookkeeping — and anything but
 * "the tag is not a version name" is logged.
 */
export function createVersionLinker({
  team,
  clock,
  logger,
}: {
  team: TeamDb;
  clock: Clock;
  logger: Logger;
}) {
  async function ensureVersion(
    projectId: string,
    name: string,
    actorId: string,
  ): Promise<{ row: VersionRow; created: boolean } | undefined> {
    const found = await team.findVersionByName(projectId, name);
    if (found) return { row: found, created: false };
    if ((await team.countVersions(projectId)) >= VERSIONS_PER_PROJECT)
      throw new AppError(
        "conflict",
        `too many versions (max ${VERSIONS_PER_PROJECT})`,
      );
    const id = `ver_${randomHex(8)}`;
    try {
      await team.createVersion(
        { id, projectId, name, note: null },
        { actorId, at: nowSec(clock) },
      );
    } catch (e) {
      // A concurrent commit of the same version won the unique index.
      if (!isConflict(e)) throw e;
      const again = await team.findVersionByName(projectId, name);
      if (!again) throw e;
      return { row: again, created: false };
    }
    const row = await team.findVersion(id);
    if (!row) throw new AppError("unavailable", "version vanished");
    return { row, created: true };
  }

  async function ensureLink(
    versionId: string,
    artifactId: string,
    actorId: string,
  ): Promise<string> {
    const links = await team.listVersionLinks(versionId);
    const existing = links.find(
      (l) => l.kind === "artifact" && l.artifactId === artifactId,
    );
    if (existing) return existing.id;
    if (links.length >= LINKS_PER_VERSION)
      throw new AppError(
        "conflict",
        `too many links (max ${LINKS_PER_VERSION})`,
      );
    const id = `lnk_${randomHex(8)}`;
    try {
      await team.addVersionLink(
        { id, versionId, kind: "artifact", artifactId },
        { actorId, at: nowSec(clock) },
      );
      return id;
    } catch (e) {
      if (!isConflict(e)) throw e;
      const raced = (await team.listVersionLinks(versionId)).find(
        (l) => l.kind === "artifact" && l.artifactId === artifactId,
      );
      if (!raced) throw e;
      return raced.id;
    }
  }

  return {
    /** Never throws. */
    async linkArtifact(input: LinkTarget): Promise<CommitVersion | null> {
      const name = versionNameFromTag(input.tag);
      if (name === undefined) return null;
      try {
        const v = await ensureVersion(input.projectId, name, input.actorId);
        if (!v) return null;
        const linkId = await ensureLink(
          v.row.id,
          input.artifactId,
          input.actorId,
        );
        return { id: v.row.id, name: v.row.name, linkId, created: v.created };
      } catch (e) {
        logger.warn("catalog.version_link_skipped", {
          artifactId: input.artifactId,
          appId: input.appId,
          projectId: input.projectId,
          actorId: input.actorId,
          version: name,
          code: e instanceof AppError ? e.code : "error",
          message: e instanceof Error ? e.message : String(e),
        });
        return null;
      }
    },
    /**
     * The read-only twin for a repeated commit: reports the link the first
     * commit made and never writes, so a version an owner deleted (or a link
     * they removed) stays deleted. Never throws.
     */
    async findArtifactLink(
      input: Omit<LinkTarget, "actorId">,
    ): Promise<CommitVersion | null> {
      const name = versionNameFromTag(input.tag);
      if (name === undefined) return null;
      try {
        const v = await team.findVersionByName(input.projectId, name);
        if (!v) return null;
        const link = (await team.listVersionLinks(v.id)).find(
          (l) => l.kind === "artifact" && l.artifactId === input.artifactId,
        );
        return link
          ? { id: v.id, name: v.name, linkId: link.id, created: false }
          : null;
      } catch (e) {
        logger.warn("catalog.version_link_skipped", {
          artifactId: input.artifactId,
          appId: input.appId,
          projectId: input.projectId,
          version: name,
          code: e instanceof AppError ? e.code : "error",
          message: e instanceof Error ? e.message : String(e),
        });
        return null;
      }
    },
  };
}
