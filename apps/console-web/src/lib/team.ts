import { api } from "../api";
import { useApiQuery } from "./query";
import { canWriteTeam, isTeamOwner, type TeamStanding } from "../types";

export const STANDING_TONE: Record<TeamStanding, string> = {
  owner: "accent",
  member: "ok",
  pending: "warn",
  admin: "neutral",
};

/**
 * The caller's standing in a team, from `GET /teams/{id}` (`role`). Resource
 * views carry no standing of their own, so detail pages ask the team once:
 * `member`/`owner` may write, `admin` (no seat) reads, `pending` sees the name.
 * A legacy resource with no team (`teamId === null`) is read-only.
 */
export function useTeamStanding(teamId: string | null | undefined) {
  const q = useApiQuery(
    ["team", teamId ?? null],
    () => api.team(teamId ?? ""),
    { enabled: !!teamId },
  );
  const standing = q.data?.role;
  return {
    team: q.data,
    standing,
    loading: !!teamId && q.loading,
    error: q.error,
    canWrite: canWriteTeam(standing),
    owner: isTeamOwner(standing),
    reload: q.reload,
    set: q.set,
  };
}

export const teamUrl = (team: string, tab?: string) =>
  `/teams/${encodeURIComponent(team)}${tab ? `/${tab}` : ""}`;
export const projectUrl = (team: string, prj: string, tab?: string) =>
  `${teamUrl(team)}/projects/${encodeURIComponent(prj)}${tab ? `/${tab}` : ""}`;
export const issueUrl = (team: string, prj: string, n: number) =>
  `${projectUrl(team, prj)}/issues/${n}`;
export const discussionUrl = (team: string, id: string) =>
  `${teamUrl(team)}/discussions/${encodeURIComponent(id)}`;
