import { AppError } from "@yyt/core";
import {
  toAuthChannel,
  type ChannelRow,
  type ConsoleDb,
  type MemberInput,
} from "./channels.js";

/** In-memory `ConsoleDb` for tests: same contract as the MySQL repository, no SQL. */
export function createMemoryConsoleDb(): ConsoleDb & {
  channels: Map<string, ChannelRow>;
  members: Map<string, MemberInput>;
  /** Test helper: soft-delete or disable a channel. */
  patchChannel(id: string, patch: Partial<ChannelRow>): void;
} {
  const channels = new Map<string, ChannelRow>();
  const members = new Map<string, MemberInput>();
  const findChannelRow = async (id: string) => {
    const r = channels.get(id);
    return r && r.deletedAt === null ? { ...r } : undefined;
  };
  return {
    channels,
    members,
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
      members.set(m.id, { ...m });
      return m.id;
    },
  };
}
