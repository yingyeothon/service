import {
  Anchor,
  Button,
  Card,
  Group,
  NativeSelect,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { HistoryList } from "../components/HistoryList";
import { Markdown } from "../components/Markdown";
import { MdField } from "../components/MdField";
import { Badge, Confirm, CopyField, Notice, Spinner } from "../components/ui";
import { fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";
import {
  STANDING_TONE,
  discussionUrl,
  projectUrl,
  teamUrl,
  useTeamStanding,
} from "../lib/team";
import type { Member, TeamDetail, TeamMember } from "../types";
import { RotationNotice, type LeftState } from "./Teams";

const TABS = ["projects", "members", "discussions", "history", "settings"];

export function TeamPage() {
  const { team: teamId = "", tab = "projects" } = useParams();
  const nav = useNavigate();
  const t = useTeamStanding(teamId);

  if (t.error) return <Notice kind="error">{t.error}</Notice>;
  if (!t.team) return <Spinner />;
  const team = t.team;

  if (team.role === "pending")
    return (
      <>
        <Title order={2} mb="sm">
          {team.name}
        </Title>
        <PendingNotice team={team} />
      </>
    );

  return (
    <>
      <Text size="sm" mb="xs">
        <Anchor component={Link} to="/teams">
          ← Teams
        </Anchor>
      </Text>
      <Group gap="xs" mb="xs" align="center">
        <Title order={2}>{team.name}</Title>
        <Badge tone={STANDING_TONE[team.role]}>{team.role}</Badge>
        {team.adminLocked && <Badge tone="danger">admin-locked</Badge>}
      </Group>
      {team.role === "admin" && (
        <Notice>
          You are viewing this team as a platform admin without a seat: you can
          read everything, delete the team or appoint an owner, but never see or
          change secrets and config.
        </Notice>
      )}
      <Markdown text={team.description ?? ""} />
      <Text size="xs" c="dimmed" mb="sm">
        Created by {team.createdBy ?? "—"} · {fmtTime(team.createdAt)} ·{" "}
        {team.counts?.projects ?? 0} project(s) · {team.counts?.owners ?? 0}{" "}
        owner(s), {team.counts?.members ?? 0} member(s)
        {team.counts?.pending ? `, ${team.counts.pending} pending` : ""}
      </Text>
      <Tabs
        value={TABS.includes(tab) ? tab : "projects"}
        onChange={(v) => void nav(teamUrl(teamId, v ?? undefined))}
        keepMounted={false}
        mb="md"
      >
        <Tabs.List>
          <Tabs.Tab value="projects">Projects</Tabs.Tab>
          <Tabs.Tab value="members">Members</Tabs.Tab>
          <Tabs.Tab value="discussions">Discussions</Tabs.Tab>
          <Tabs.Tab value="history">History</Tabs.Tab>
          <Tabs.Tab value="settings">Settings</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="projects" pt="sm">
          <ProjectsTab team={team} canWrite={t.canWrite} />
        </Tabs.Panel>
        <Tabs.Panel value="members" pt="sm">
          <MembersTab team={team} owner={t.owner} onChanged={t.reload} />
        </Tabs.Panel>
        <Tabs.Panel value="discussions" pt="sm">
          <DiscussionsTab team={team} canWrite={t.canWrite} />
        </Tabs.Panel>
        <Tabs.Panel value="history" pt="sm">
          <HistoryList team={teamId} />
        </Tabs.Panel>
        <Tabs.Panel value="settings" pt="sm">
          <SettingsTab
            team={team}
            owner={t.owner}
            canDelete={t.owner || team.role === "admin"}
            onChange={t.set}
          />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

function PendingNotice({ team }: { team: TeamDetail }) {
  const { me } = useAuth();
  const nav = useNavigate();
  const act = useAction();
  const withdraw = async () => {
    const ok = await act.run(async () => {
      await api.removeTeamMember(team.id, me?.id ?? "");
      return true;
    });
    if (ok) void nav("/teams");
  };
  return (
    <Notice kind="warn">
      <Text size="sm" mb="xs">
        Your request to join <strong>{team.name}</strong> is waiting for an
        owner. Withdrawing counts as declined: you will have to wait before
        asking again.
      </Text>
      {act.error && <Text c="red">{act.error}</Text>}
      <Confirm
        label="Withdraw request"
        onConfirm={withdraw}
        disabled={act.busy}
      />
    </Notice>
  );
}

function ProjectsTab({
  team,
  canWrite,
}: {
  team: TeamDetail;
  canWrite: boolean;
}) {
  const list = useApiQuery(["projects", team.id], () => api.projects(team.id));
  const act = useAction();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() =>
      api.createProject(team.id, { name: name.trim() }),
    );
    if (!r) return;
    setName("");
    void nav(projectUrl(team.id, r.id));
  };
  return (
    <>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {canWrite && (
        <Card withBorder mb="md" padding="sm">
          <form onSubmit={(e) => void create(e)}>
            <Group align="end" wrap="wrap">
              <TextInput
                label="New project"
                placeholder="name (e.g. dungeon)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={64}
              />
              <Button type="submit" disabled={act.busy || !name.trim()}>
                Create project
              </Button>
            </Group>
          </form>
        </Card>
      )}
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <Table.ScrollContainer minWidth={480}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Project</Table.Th>
                <Table.Th>Description</Table.Th>
                <Table.Th>Created by</Table.Th>
                <Table.Th>Updated</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.data.map((p) => (
                <Table.Tr key={p.id}>
                  <Table.Td>
                    <Anchor
                      component={Link}
                      to={projectUrl(team.id, p.id)}
                      size="sm"
                    >
                      {p.name}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" lineClamp={1}>
                      {p.description ?? "—"}
                    </Text>
                  </Table.Td>
                  <Table.Td>{p.createdBy ?? "—"}</Table.Td>
                  <Table.Td>{fmtTime(p.updatedAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <Text size="sm" c="dimmed">
          No projects yet.
        </Text>
      )}
    </>
  );
}

const ROLE_TONE: Record<TeamMember["role"], string> = {
  owner: "accent",
  member: "ok",
  pending: "warn",
};

/**
 * Roster and seat management. Owners approve/promote/demote/kick and add by
 * GitHub login; anyone may leave; a platform admin without a seat may only
 * appoint an owner (a non-admin member other than themselves).
 */
function MembersTab({
  team,
  owner,
  onChanged,
}: {
  team: TeamDetail;
  owner: boolean;
  /** Refreshes the header counts (`GET /teams/{id}`) after a seat changes. */
  onChanged: () => Promise<void>;
}) {
  const { me } = useAuth();
  const nav = useNavigate();
  const list = useApiQuery(["team", team.id, "members"], () =>
    api.teamMembers(team.id),
  );
  const admin = team.role === "admin";
  // Appointing needs a member id; the platform roster is admin-only anyway.
  const platform = useApiQuery(["members"], () => api.members(), {
    enabled: admin,
  });
  const act = useAction();
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<"member" | "owner">("member");
  const [appoint, setAppoint] = useState("");
  const [kicked, setKicked] = useState<{
    who: string;
    rotate: LeftState["rotate"];
  } | null>(null);

  const refresh = async () => {
    await list.reload();
    await onChanged();
  };
  const setRoleOf = async (m: TeamMember, to: "member" | "owner") => {
    if (await act.run(() => api.setTeamMemberRole(team.id, m.id, to)))
      await refresh();
  };
  const remove = async (m: TeamMember) => {
    // `run` yields `undefined` on error; a declined pending request is a 204,
    // mapped to `null` so the two cannot be confused (a failed leave must not
    // navigate away as if it succeeded).
    const r = await act.run(
      async () => (await api.removeTeamMember(team.id, m.id)) ?? null,
    );
    if (r === undefined) return;
    if (m.id === me?.id && m.role !== "pending") {
      const state: LeftState = { left: team.name, rotate: r?.rotate ?? [] };
      void nav("/teams", { state });
      return;
    }
    if (r) setKicked({ who: m.login ?? m.id, rotate: r.rotate });
    await refresh();
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await act.run(() => api.addTeamMember(team.id, login.trim(), role))) {
      setLogin("");
      await refresh();
    }
  };
  const appointOwner = async (e: FormEvent) => {
    e.preventDefault();
    if (await act.run(() => api.setTeamMemberRole(team.id, appoint, "owner"))) {
      setAppoint("");
      await refresh();
    }
  };

  const seated = (list.data ?? []).filter((m) => m.state === "active");
  const appointable = (platform.data ?? []).filter(
    (m: Member) => m.role === "member" && m.id !== me?.id,
  );

  return (
    <>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {kicked && <RotationNotice rotate={kicked.rotate} who={kicked.who} />}
      {owner && (
        <Card withBorder mb="md" padding="sm">
          <form onSubmit={(e) => void add(e)}>
            <Group align="end" wrap="wrap">
              <TextInput
                label="Add by GitHub login"
                placeholder="octocat (must already be a platform member)"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                required
                maxLength={100}
              />
              <NativeSelect
                label="Role"
                value={role}
                onChange={(e) => setRole(e.target.value as "member" | "owner")}
                data={["member", "owner"]}
              />
              <Button type="submit" disabled={act.busy || !login.trim()}>
                Add
              </Button>
            </Group>
          </form>
        </Card>
      )}
      {admin && (
        <Card withBorder mb="md" padding="sm">
          <form onSubmit={(e) => void appointOwner(e)}>
            <Group align="end" wrap="wrap">
              <NativeSelect
                label="Appoint an owner (admin)"
                description="A non-admin platform member; they need not be seated yet."
                value={appoint}
                onChange={(e) => setAppoint(e.target.value)}
                data={[
                  { value: "", label: "— choose —" },
                  ...appointable.map((m) => ({ value: m.id, label: m.login })),
                ]}
              />
              <Button type="submit" disabled={act.busy || !appoint}>
                Appoint owner
              </Button>
            </Group>
          </form>
        </Card>
      )}
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {list.loading && !list.data ? (
        <Spinner />
      ) : (
        <Table.ScrollContainer minWidth={560}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Login</Table.Th>
                <Table.Th>Role</Table.Th>
                <Table.Th>Since</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {seated.map((m) => {
                const self = m.id === me?.id;
                return (
                  <Table.Tr key={m.id}>
                    <Table.Td>
                      {m.login ?? m.id}
                      {self && (
                        <Text span size="sm" c="dimmed">
                          {" "}
                          (you)
                        </Text>
                      )}
                      {m.platformRole === "admin" && (
                        <>
                          {" "}
                          <Badge tone="neutral">platform admin</Badge>
                        </>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Badge tone={ROLE_TONE[m.role]}>{m.role}</Badge>
                    </Table.Td>
                    <Table.Td>{fmtTime(m.decidedAt ?? m.requestedAt)}</Table.Td>
                    <Table.Td>
                      <Group gap="xs">
                        {owner && m.role === "pending" && (
                          <>
                            <Button
                              size="compact-sm"
                              disabled={act.busy}
                              onClick={() => void setRoleOf(m, "member")}
                            >
                              Approve
                            </Button>
                            <Confirm
                              label="Decline"
                              onConfirm={() => remove(m)}
                              disabled={act.busy}
                            />
                          </>
                        )}
                        {owner && m.role === "member" && (
                          <Confirm
                            label="Promote to owner"
                            color="brand"
                            variant="default"
                            onConfirm={() => setRoleOf(m, "owner")}
                            disabled={act.busy}
                          />
                        )}
                        {owner && m.role === "owner" && (
                          <Confirm
                            label="Demote"
                            color="brand"
                            variant="default"
                            onConfirm={() => setRoleOf(m, "member")}
                            disabled={act.busy}
                          />
                        )}
                        {owner && !self && m.role !== "pending" && (
                          <Confirm
                            label="Kick"
                            onConfirm={() => remove(m)}
                            disabled={act.busy}
                          />
                        )}
                        {self && (
                          <Confirm
                            label="Leave team"
                            onConfirm={() => remove(m)}
                            disabled={act.busy}
                          />
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      <Text size="xs" c="dimmed" mt="xs">
        Kicking or leaving revokes nothing: the person still knows every channel
        secret they saw. The response lists what to rotate.
      </Text>
    </>
  );
}

function DiscussionsTab({
  team,
  canWrite,
}: {
  team: TeamDetail;
  canWrite: boolean;
}) {
  const list = useApiQuery(["discussions", team.id], () =>
    api.discussions(team.id),
  );
  const act = useAction();
  const nav = useNavigate();
  const [draft, setDraft] = useState<{ title: string; bodyMd: string } | null>(
    null,
  );
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const r = await act.run(() =>
      api.createDiscussion(team.id, {
        title: draft.title.trim(),
        bodyMd: draft.bodyMd,
      }),
    );
    if (r) void nav(discussionUrl(team.id, r.id));
  };
  return (
    <>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {canWrite && !draft && (
        <Button
          size="compact-sm"
          mb="sm"
          onClick={() => setDraft({ title: "", bodyMd: "" })}
        >
          New discussion
        </Button>
      )}
      {draft && (
        <Card withBorder mb="md" padding="sm">
          <form onSubmit={(e) => void create(e)}>
            <Stack gap="xs">
              <TextInput
                label="Title"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                required
                maxLength={200}
              />
              <MdField
                label="Body"
                value={draft.bodyMd}
                onChange={(bodyMd) => setDraft({ ...draft, bodyMd })}
              />
              <Group>
                <Button
                  type="submit"
                  disabled={act.busy || !draft.title.trim()}
                >
                  Post
                </Button>
                <Button variant="default" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
              </Group>
            </Stack>
          </form>
        </Card>
      )}
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <Table.ScrollContainer minWidth={480}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Title</Table.Th>
                <Table.Th>By</Table.Th>
                <Table.Th>Updated</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.data.map((d) => (
                <Table.Tr key={d.id}>
                  <Table.Td>
                    <Anchor
                      component={Link}
                      to={discussionUrl(team.id, d.id)}
                      size="sm"
                    >
                      {d.title}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>{d.createdBy ?? "—"}</Table.Td>
                  <Table.Td>{fmtTime(d.updatedAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <Text size="sm" c="dimmed">
          No discussions yet.
        </Text>
      )}
    </>
  );
}

function SettingsTab({
  team,
  owner,
  canDelete,
  onChange,
}: {
  team: TeamDetail;
  owner: boolean;
  /** Owner, or a platform admin with no seat (a seated admin is judged by the seat). */
  canDelete: boolean;
  onChange: (t: TeamDetail) => void;
}) {
  const { me } = useAuth();
  const nav = useNavigate();
  const act = useAction();
  const [name, setName] = useState<string | null>(null);
  const [desc, setDesc] = useState<string | null>(null);
  const admin = me?.role === "admin";

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body: { name?: string; description?: string | null } = {};
    if (name !== null && name.trim() !== team.name) body.name = name.trim();
    if (desc !== null && desc !== (team.description ?? ""))
      body.description = desc === "" ? null : desc;
    if (Object.keys(body).length === 0) return;
    const r = await act.run(() => api.updateTeam(team.id, body));
    if (!r) return;
    onChange({ ...team, ...r });
    setName(null);
    setDesc(null);
  };
  const lock = async (locked: boolean) => {
    const r = await act.run(() => api.setTeamAdminLock(team.id, locked));
    if (r) onChange({ ...team, ...r });
  };
  const remove = async () => {
    const ok = await act.run(async () => {
      await api.deleteTeam(team.id);
      return true;
    });
    if (ok) void nav("/teams");
  };

  return (
    <>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <Card withBorder mb="md" padding="sm">
        <CopyField label="Team id" value={team.id} />
        <Text size="xs" c="dimmed">
          For the CLI: <code>yyt team use {team.id}</code> or{" "}
          <code>{`.yyt.json {"team":"${team.id}"}`}</code>.
        </Text>
      </Card>
      {owner && (
        <Card withBorder mb="md" padding="sm">
          <form onSubmit={(e) => void save(e)}>
            <Stack gap="xs">
              <TextInput
                label="Name"
                value={name ?? team.name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={64}
              />
              <MdField
                label="Description"
                value={desc ?? team.description ?? ""}
                onChange={setDesc}
              />
              <Group>
                <Button type="submit" disabled={act.busy}>
                  Save
                </Button>
              </Group>
            </Stack>
          </form>
        </Card>
      )}
      {admin && (
        <Card withBorder mb="md" padding="sm">
          <Switch
            label="Admin-locked (every seat must be a platform admin)"
            description="Required of the team that owns the installer app: any member could otherwise push an APK every device self-updates to."
            checked={!!team.adminLocked}
            disabled={act.busy}
            onChange={(e) => void lock(e.currentTarget.checked)}
          />
        </Card>
      )}
      {canDelete && (
        <Card withBorder padding="sm">
          <Text size="sm" mb="xs">
            Deleting a team is refused while it still has projects.
          </Text>
          <Confirm
            label="Delete team"
            confirmLabel="Delete"
            onConfirm={remove}
            disabled={act.busy}
          />
        </Card>
      )}
    </>
  );
}
