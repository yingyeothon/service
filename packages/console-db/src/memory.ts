import { AppError } from "@yyt/core";
import {
  toAuthChannel,
  type ApiTokenRow,
  type AuditInput,
  type ChannelRow,
  type ConsoleDb,
  type MemberRow,
} from "./channels.js";

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
  const members = new Map<string, MemberRow>();
  const tokens = new Map<string, ApiTokenRow>();
  const audits: AuditInput[] = [];
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
    insertChannel: async (c) => {
      if (channels.has(c.id)) throw new AppError("conflict", "duplicate key");
      if (!members.has(c.ownerId))
        throw new AppError("unavailable", "database error");
      channels.set(c.id, {
        id: c.id,
        kind: c.kind,
        ownerId: c.ownerId,
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
            c.deletedAt === null &&
            (!filter.kind || c.kind === filter.kind) &&
            (!filter.ownerId || c.ownerId === filter.ownerId),
        )
        .map((c) => ({ ...c }))
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)),
    updateChannel: async (id, patch) => {
      const c = channels.get(id);
      if (!c || c.deletedAt !== null) return false;
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
      const deleted: string[] = [];
      for (const c of channels.values()) {
        if (c.deletedAt !== null) continue;
        if (c.disabledAt === null && c.expiresAt <= now) {
          channels.set(c.id, { ...c, disabledAt: now });
          disabled.push(c.id);
        } else if (c.disabledAt !== null && c.disabledAt + graceSec < now) {
          channels.set(c.id, { ...c, deletedAt: now, secretJson: "{}" });
          deleted.push(c.id);
        }
      }
      return { disabled, deleted };
    },
    insertAudit: async (a) => {
      if (audits.some((x) => x.id === a.id))
        throw new AppError("conflict", "duplicate key");
      audits.push({ ...a });
    },
  };
}
