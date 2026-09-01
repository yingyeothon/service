import { AppError } from "@yyt/core";
import {
  AUDIT_PAGE_DEFAULT,
  AUDIT_PAGE_MAX,
  checkAuditFilter,
  toAuthChannel,
  toMatchChannel,
  toTopicChannel,
  type ApiTokenRow,
  type AuditInput,
  type AuditListRow,
  type AuditRow,
  type ChannelRow,
  type ConsoleDb,
  type ExpiredChannel,
  type MemberRow,
} from "./channels.js";
import { decodeHistoryCursor, encodeHistoryCursor } from "./team.js";

/** In-memory `ConsoleDb` for tests: same contract as the MySQL repository, no SQL. */
export function createMemoryConsoleDb(): ConsoleDb & {
  channels: Map<string, ChannelRow>;
  members: Map<string, MemberRow>;
  tokens: Map<string, ApiTokenRow>;
  audits: AuditInput[];
  /** Test helper: soft-delete or disable a channel. */
  patchChannel(id: string, patch: Partial<ChannelRow>): void;
} {
  const channels = new Map<string, ChannelRow>();
  const conflictKey = () => new AppError("conflict", "duplicate key");
  // `channels_team_name` is unique, case-insensitive and has no deleted_at
  // filter: a soft-deleted channel holds its name until `purgeChannels`.
  const nameHeld = (teamId: string | null, name: string, exceptId?: string) =>
    [...channels.values()].some(
      (x) =>
        x.id !== exceptId &&
        x.teamId === teamId &&
        x.name.toLowerCase() === name.toLowerCase(),
    );
  const members = new Map<string, MemberRow>();
  const tokens = new Map<string, ApiTokenRow>();
  const audits: AuditInput[] = [];
  /** Mirrors what `insertAudit` stores: `detail` is serialized into the column. */
  const toAuditRow = (a: AuditInput): AuditRow => ({
    ...toAuditListRow(a),
    detailJson: a.detail === undefined ? null : JSON.stringify(a.detail),
  });
  const toAuditListRow = (a: AuditInput): AuditListRow => ({
    id: a.id,
    actorId: a.actorId,
    action: a.action,
    target: a.target,
    at: a.at,
  });
  /** `audit_log` sits on the database default `utf8mb4_unicode_ci`. */
  const eqI = (a: string | null, b: string) =>
    a !== null && a.toLowerCase() === b.toLowerCase();
  const findChannelRow = async (id: string) => {
    const r = channels.get(id);
    return r && r.deletedAt === null ? { ...r } : undefined;
  };
  return {
    channels,
    members,
    tokens,
    audits,
    patchChannel: (id, patch) => {
      const r = channels.get(id);
      if (!r) throw new Error(`no channel ${id}`);
      channels.set(id, { ...r, ...patch });
    },
    findChannelRow,
    findAuthChannel: async (id) => {
      const row = await findChannelRow(id);
      return row && toAuthChannel(row);
    },
    findMatchChannel: async (id) => {
      const row = await findChannelRow(id);
      return row && toMatchChannel(row);
    },
    findTopicChannel: async (id) => {
      const row = await findChannelRow(id);
      return row && toTopicChannel(row);
    },
    insertChannel: async (c) => {
      if (channels.has(c.id)) throw conflictKey();
      if (nameHeld(c.teamId, c.name)) throw conflictKey();
      if (!members.has(c.ownerId))
        throw new AppError("unavailable", "database error");
      channels.set(c.id, {
        id: c.id,
        kind: c.kind,
        ownerId: c.ownerId,
        teamId: c.teamId,
        projectId: c.projectId,
        name: c.name,
        configJson: JSON.stringify(c.config),
        secretJson: JSON.stringify(c.secret),
        createdAt: c.createdAt,
        expiresAt: c.expiresAt,
        disabledAt: null,
        deletedAt: null,
      });
    },
    upsertMember: async (m) => {
      const byGithub = [...members.values()].find(
        (x) => x.githubId === m.githubId,
      );
      if (byGithub) {
        members.set(byGithub.id, { ...byGithub, githubLogin: m.githubLogin });
        return byGithub.id;
      }
      if (members.has(m.id))
        throw new AppError("conflict", "member id bound to another github id");
      members.set(m.id, { ...m, approvedAt: null, approvedBy: null });
      return m.id;
    },
    findMember: async (id) => {
      const m = members.get(id);
      return m && { ...m };
    },
    listMembers: async () =>
      [...members.values()]
        .map((m) => ({ ...m }))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    setMemberRole: async (id, role, approval) => {
      const m = members.get(id);
      if (!m) return false;
      members.set(id, {
        ...m,
        role,
        ...(approval === undefined
          ? {}
          : {
              approvedAt: approval?.at ?? null,
              approvedBy: approval?.by ?? null,
            }),
      });
      return true;
    },
    insertApiToken: async (t) => {
      if (
        tokens.has(t.id) ||
        [...tokens.values()].some((x) => x.tokenHash === t.tokenHash)
      )
        throw new AppError("conflict", "duplicate key");
      if (!members.has(t.memberId))
        throw new AppError("unavailable", "database error");
      tokens.set(t.id, { ...t, lastUsedAt: null, revokedAt: null });
    },
    findApiTokenByHash: async (hash) => {
      const t = [...tokens.values()].find(
        (x) => x.tokenHash === hash && x.revokedAt === null,
      );
      return t && { ...t };
    },
    listApiTokens: async (memberId) =>
      [...tokens.values()]
        .filter((t) => t.memberId === memberId && t.revokedAt === null)
        .map((t) => ({ ...t }))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    revokeApiToken: async (id, memberId, at) => {
      const t = tokens.get(id);
      if (!t || t.memberId !== memberId || t.revokedAt !== null) return false;
      tokens.set(id, { ...t, revokedAt: at });
      return true;
    },
    touchApiToken: async (id, at) => {
      const t = tokens.get(id);
      if (t) tokens.set(id, { ...t, lastUsedAt: at });
    },
    listChannels: async (filter = {}) =>
      [...channels.values()]
        .filter(
          (c) =>
            (filter.includeDeleted || c.deletedAt === null) &&
            (!filter.kind || c.kind === filter.kind) &&
            (!filter.teamId || c.teamId === filter.teamId) &&
            (!filter.teamIds ||
              (c.teamId !== null && filter.teamIds.includes(c.teamId))) &&
            (!filter.projectId || c.projectId === filter.projectId),
        )
        .map((c) => ({ ...c }))
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)),
    updateChannel: async (id, patch) => {
      const c = channels.get(id);
      if (!c || c.deletedAt !== null) return false;
      if (patch.name !== undefined && nameHeld(c.teamId, patch.name, id))
        throw conflictKey();
      channels.set(id, {
        ...c,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.config !== undefined
          ? { configJson: JSON.stringify(patch.config) }
          : {}),
        ...(patch.secret !== undefined
          ? { secretJson: JSON.stringify(patch.secret) }
          : {}),
        ...(patch.expiresAt !== undefined
          ? { expiresAt: patch.expiresAt }
          : {}),
        ...(patch.disabledAt !== undefined
          ? { disabledAt: patch.disabledAt }
          : {}),
        ...(patch.deletedAt !== undefined
          ? { deletedAt: patch.deletedAt }
          : {}),
      });
      return true;
    },
    expireChannels: async (now, graceSec) => {
      const disabled: string[] = [];
      const deleted: ExpiredChannel[] = [];
      for (const c of channels.values()) {
        if (c.deletedAt !== null) continue;
        if (c.disabledAt === null && c.expiresAt <= now) {
          channels.set(c.id, { ...c, disabledAt: now });
          disabled.push(c.id);
        } else if (c.disabledAt !== null && c.disabledAt + graceSec < now) {
          channels.set(c.id, { ...c, deletedAt: now, secretJson: "{}" });
          deleted.push({
            id: c.id,
            kind: c.kind,
            name: c.name,
            teamId: c.teamId,
            projectId: c.projectId,
          });
        }
      }
      return { disabled, deleted };
    },
    purgeChannels: async (now, retainSec) => {
      const ids = [...channels.values()]
        .filter((c) => c.deletedAt !== null && c.deletedAt < now - retainSec)
        .map((c) => c.id);
      for (const id of ids) channels.delete(id);
      return ids;
    },
    insertAudit: async (a) => {
      if (audits.some((x) => x.id === a.id))
        throw new AppError("conflict", "duplicate key");
      audits.push({ ...a });
    },
    listAudit: async (filter = {}) => {
      checkAuditFilter(filter);
      const limit = Math.min(
        AUDIT_PAGE_MAX,
        Math.max(1, filter.limit ?? AUDIT_PAGE_DEFAULT),
      );
      const cursor = filter.cursor
        ? decodeHistoryCursor(filter.cursor)
        : undefined;
      if (filter.cursor && !cursor)
        throw new AppError("bad_request", "invalid cursor");
      const all = audits
        .filter(
          (a) =>
            (filter.action === undefined || eqI(a.action, filter.action)) &&
            (filter.actionPrefix === undefined ||
              a.action
                .toLowerCase()
                .startsWith(filter.actionPrefix.toLowerCase())) &&
            (filter.target === undefined || eqI(a.target, filter.target)) &&
            (filter.actorId === undefined || eqI(a.actorId, filter.actorId)) &&
            (filter.from === undefined || a.at >= filter.from) &&
            (filter.to === undefined || a.at <= filter.to),
        )
        .map(toAuditListRow)
        .sort(
          (a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        );
      const rest = cursor
        ? all.filter(
            (a) => a.at < cursor.at || (a.at === cursor.at && a.id < cursor.id),
          )
        : all;
      const rows = rest.slice(0, limit);
      const last = rows[rows.length - 1];
      return rest.length > limit && last
        ? { rows, next: encodeHistoryCursor(last) }
        : { rows };
    },
    findAudit: async (id) => {
      const a = audits.find((x) => x.id === id);
      return a && toAuditRow(a);
    },
  };
}
