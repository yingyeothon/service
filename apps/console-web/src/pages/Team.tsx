import {
  Button,
  Code,
  NativeSelect,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
} from "@mantine/core";
import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { Crumbs } from "../components/Crumbs";
import { DataTable, NameCell } from "../components/DataTable";
import { HistoryList } from "../components/HistoryList";
import { PageSkeleton } from "../components/Loading";
import { Markdown } from "../components/Markdown";
import { MdField } from "../components/MdField";
import { NameDescriptionFields } from "../components/NameDescriptionFields";
import { PageHeader, type HeaderAction } from "../components/PageHeader";
import { ReadOnlyBanner } from "../components/ReadOnlyBanner";
import { ResourceDrawer, useDrawerForm } from "../components/ResourceDrawer";
import { RowMenu, type RowMenuItem } from "../components/RowMenu";
import { Section } from "../components/Section";
import { Badge, CopyField, Notice } from "../components/ui";
import { useConfirm } from "../lib/confirm";
import { fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
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

const TABS = ["projects", "members", "discussions", "history"];
const TEAMS_CRUMB = [{ label: "Teams", to: "/teams" }];

export function TeamPage() {
  const { team: teamId = "", tab = "projects" } = useParams();
  const nav = useNavigate();
  const { me } = useAuth();
  const t = useTeamStanding(teamId);
  const act = useAction();
  const confirm = useConfirm();
  const team = t.team;
  const edit = useDrawerForm(() => ({
    name: team?.name ?? "",
    description: team?.description ?? "",
  }));

  if (t.error)
    return (
      <>
        <Crumbs trail={TEAMS_CRUMB} />
        <PageHeader />
        <Notice kind="error">{t.error}</Notice>
      </>
    );
  if (!team)
    return (
      <>
        <Crumbs trail={TEAMS_CRUMB} />
        <PageHeader />
        <PageSkeleton />
      </>
    );

  if (team.role === "pending")
    return (
      <>
        <Crumbs trail={TEAMS_CRUMB} current={team.name} />
        <PageHeader title={team.name} />
        <PendingNotice team={team} />
      </>
    );

  const canDelete = t.owner || team.role === "admin";
  const admin = me?.role === "admin";

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body: { name?: string; description?: string | null } = {};
    const name = edit.form.name.trim();
    if (name !== team.name) body.name = name;
    if (edit.form.description !== (team.description ?? ""))
      body.description =
        edit.form.description === "" ? null : edit.form.description;
    if (Object.keys(body).length === 0) {
      edit.close();
      return;
    }
    const r = await act.run(() => api.updateTeam(team.id, body));
    if (!r) return;
    t.set({ ...team, ...r });
    edit.close();
    notify.saved("team");
  };
  const remove = async () => {
    const ok = await act.run(async () => {
      await api.deleteTeam(team.id);
      return true;
    });
    if (!ok) return;
    notify.deleted("team");
    void nav("/teams");
  };
  const leave = async () => {
    const r = await confirm({
      title: "Leave team?",
      message: `You lose your seat in ${team.name}; an owner has to add you again. Nothing is revoked: rotate the channel secrets you saw when it is safe.`,
      confirmLabel: "Leave team",
      danger: true,
    });
    if (!r.ok || !me) return;
    const res = await act.run(
      async () => (await api.removeTeamMember(team.id, me.id)) ?? null,
    );
    if (res === undefined) return;
    const state: LeftState = { left: team.name, rotate: res?.rotate ?? [] };
    void nav("/teams", { state });
  };
  const lock = async (locked: boolean) => {
    const r = await confirm({
      title: locked ? "Admin-lock this team?" : "Remove the admin lock?",
      message: locked
        ? "Every seat must then be a platform admin. Required of the team that owns the installer app: any member could otherwise push an APK every device self-updates to."
        : "Members who are not platform admins may then be seated again.",
      confirmLabel: locked ? "Admin-lock team" : "Remove admin lock",
    });
    if (!r.ok) return;
    const res = await act.run(() => api.setTeamAdminLock(team.id, locked));
    if (res) {
      t.set({ ...team, ...res });
      notify.saved("team");
    }
  };

  const actions: HeaderAction[] = [];
  if (t.owner) actions.push({ label: "Edit", onClick: edit.open });
  if (admin)
    actions.push({
      label: team.adminLocked ? "Remove admin lock" : "Admin-lock team",
      menu: true,
      onClick: () => lock(!team.adminLocked),
    });
  if (team.role !== "admin")
    actions.push({ label: "Leave team", menu: true, onClick: leave });

  return (
    <>
      <Crumbs trail={TEAMS_CRUMB} current={team.name} />
      <PageHeader
        title={team.name}
        badges={
          <>
            <Badge tone={STANDING_TONE[team.role]}>{team.role}</Badge>
            {team.adminLocked && <Badge tone="danger">admin-locked</Badge>}
          </>
        }
        meta={
          <>
            Created by {team.createdBy ?? "—"} · {fmtTime(team.createdAt)} ·{" "}
            {team.counts?.projects ?? 0} project(s) · {team.counts?.owners ?? 0}{" "}
            owner(s), {team.counts?.members ?? 0} member(s)
            {team.counts?.pending ? `, ${team.counts.pending} pending` : ""} ·
            id <Code>{team.id}</Code>
          </>
        }
        actions={actions}
      />
      {team.role === "admin" && (
        <ReadOnlyBanner detail="As a platform admin without a seat you can read everything, delete the team or appoint an owner, but never see or change secrets and config." />
      )}
      {act.error && !edit.opened && <Notice kind="error">{act.error}</Notice>}
      {team.description && <Markdown text={team.description} />}
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
        </Tabs.List>
        <Tabs.Panel value="projects" pt="lg">
          <ProjectsTab team={team} canWrite={t.canWrite} />
        </Tabs.Panel>
        <Tabs.Panel value="members" pt="lg">
          <MembersTab team={team} owner={t.owner} onChanged={t.reload} />
        </Tabs.Panel>
        <Tabs.Panel value="discussions" pt="lg">
          <DiscussionsTab team={team} canWrite={t.canWrite} />
        </Tabs.Panel>
        <Tabs.Panel value="history" pt="lg">
          <Section title="History">
            <HistoryList team={teamId} />
          </Section>
        </Tabs.Panel>
      </Tabs>
      <ResourceDrawer
        opened={edit.opened}
        onClose={edit.close}
        title="Edit team"
        submitLabel="Save"
        onSubmit={save}
        busy={act.busy}
        disabled={!edit.form.name.trim()}
        error={edit.opened ? act.error : null}
        danger={
          canDelete
            ? {
                label: "Delete team",
                description:
                  "Deleting a team is refused while it still has projects.",
                onConfirm: remove,
                disabled: act.busy,
              }
            : undefined
        }
      >
        <div>
          <CopyField label="Team id" value={team.id} />
          <Text size="xs" c="dimmed">
            For the CLI: <code>yyt team use {team.id}</code> or{" "}
            <code>{`.yyt.json {"team":"${team.id}"}`}</code>.
          </Text>
        </div>
        <NameDescriptionFields
          name={edit.form.name}
          description={edit.form.description}
          onName={(name) => edit.patch({ name })}
          onDescription={(description) => edit.patch({ description })}
          markdown
        />
      </ResourceDrawer>
    </>
  );
}

function PendingNotice({ team }: { team: TeamDetail }) {
  const { me } = useAuth();
  const nav = useNavigate();
  const act = useAction();
  const confirm = useConfirm();
  const withdraw = async () => {
    const r = await confirm({
      title: "Withdraw the request?",
      message:
        "Withdrawing counts as declined: you will have to wait before asking again.",
      confirmLabel: "Withdraw request",
      danger: true,
    });
    if (!r.ok) return;
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
      <Button
        variant="default"
        onClick={() => void withdraw()}
        disabled={act.busy}
      >
        Withdraw request
      </Button>
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
  const create = useDrawerForm(() => ({ name: "", description: "" }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const description = create.form.description.trim();
    const r = await act.run(() =>
      api.createProject(team.id, {
        name: create.form.name.trim(),
        ...(description ? { description } : {}),
      }),
    );
    if (!r) return;
    create.close();
    notify.created("project");
    void nav(projectUrl(team.id, r.id));
  };
  return (
    <Section
      title="Projects"
      actions={canWrite && <Button onClick={create.open}>New project</Button>}
    >
      <DataTable
        columns={[
          { key: "name", label: "Project" },
          { key: "desc", label: "Description" },
          { key: "by", label: "Created by" },
          { key: "updated", label: "Updated" },
        ]}
        rows={list.data}
        loading={list.loading}
        error={list.error}
        rowKey={(p) => p.id}
        minWidth={480}
        empty={{
          title: "No projects yet.",
          hint: canWrite
            ? "A project holds channels, apps, bundles and sites."
            : undefined,
        }}
        render={(p) => (
          <>
            <NameCell to={projectUrl(team.id, p.id)}>{p.name}</NameCell>
            <Table.Td>
              <Text size="sm" lineClamp={1}>
                {p.description ?? "—"}
              </Text>
            </Table.Td>
            <Table.Td>{p.createdBy ?? "—"}</Table.Td>
            <Table.Td>{fmtTime(p.updatedAt)}</Table.Td>
          </>
        )}
      />
      <ResourceDrawer
        opened={create.opened}
        onClose={create.close}
        title="New project"
        submitLabel="Create project"
        onSubmit={submit}
        busy={act.busy}
        disabled={!create.form.name.trim()}
        error={create.opened ? act.error : null}
      >
        <NameDescriptionFields
          name={create.form.name}
          description={create.form.description}
          onName={(name) => create.patch({ name })}
          onDescription={(description) => create.patch({ description })}
          namePlaceholder="dungeon"
          markdown
        />
      </ResourceDrawer>
    </Section>
  );
}

const ROLE_TONE: Record<TeamMember["role"], string> = {
  owner: "accent",
  member: "ok",
  pending: "warn",
};

/**
 * Roster and seat management. Owners approve/promote/demote/kick and add by
 * GitHub login; a platform admin without a seat may only appoint an owner
 * (any platform member, themselves included). Leaving lives in the page
 * header's overflow menu.
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
  const list = useApiQuery(["team", team.id, "members"], () =>
    api.teamMembers(team.id),
  );
  const admin = team.role === "admin";
  // Appointing needs a member id; the platform roster is admin-only anyway.
  const platform = useApiQuery(["members"], () => api.members(), {
    enabled: admin,
  });
  const act = useAction();
  const add = useDrawerForm<{ login: string; role: "member" | "owner" }>(
    () => ({ login: "", role: "member" }),
  );
  const appoint = useDrawerForm(() => ({ id: "" }));
  const [kicked, setKicked] = useState<{
    who: string;
    rotate: LeftState["rotate"];
  } | null>(null);

  const refresh = async () => {
    await list.reload();
    await onChanged();
  };
  const setRoleOf = async (m: TeamMember, to: "member" | "owner") => {
    if (await act.run(() => api.setTeamMemberRole(team.id, m.id, to))) {
      notify.saved(`${m.login ?? m.id}'s seat`);
      await refresh();
    }
  };
  const remove = async (m: TeamMember) => {
    // `run` yields `undefined` on error; a declined pending request is a 204,
    // mapped to `null` so the two cannot be confused.
    const r = await act.run(
      async () => (await api.removeTeamMember(team.id, m.id)) ?? null,
    );
    if (r === undefined) return;
    if (r) setKicked({ who: m.login ?? m.id, rotate: r.rotate });
    notify.done(
      m.role === "pending"
        ? `${m.login ?? m.id} declined`
        : `${m.login ?? m.id} kicked`,
    );
    await refresh();
  };
  const submitAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (
      await act.run(() =>
        api.addTeamMember(team.id, add.form.login.trim(), add.form.role),
      )
    ) {
      add.close();
      notify.done(`${add.form.login.trim()} added`);
      await refresh();
    }
  };
  const submitAppoint = async (e: FormEvent) => {
    e.preventDefault();
    if (
      await act.run(() =>
        api.setTeamMemberRole(team.id, appoint.form.id, "owner"),
      )
    ) {
      appoint.close();
      notify.done("Owner appointed");
      await refresh();
    }
  };

  const seated = (list.data ?? []).filter((m) => m.state === "active");
  const appointable = (platform.data ?? []).filter(
    (m: Member) =>
      m.role !== "pending" &&
      !seated.some((s) => s.id === m.id && s.role === "owner"),
  );

  const rowItems = (m: TeamMember): RowMenuItem[] => {
    if (!owner) return [];
    const who = m.login ?? m.id;
    const self = m.id === me?.id;
    const items: RowMenuItem[] = [];
    if (m.role === "pending")
      items.push({
        label: "Decline",
        danger: true,
        onClick: () => remove(m),
        confirm: {
          title: `Decline ${who}?`,
          message: "They will have to wait before asking again.",
          confirmLabel: "Decline",
          danger: true,
        },
      });
    if (m.role === "member")
      items.push({
        label: "Make owner",
        onClick: () => setRoleOf(m, "owner"),
        confirm: {
          title: `Make ${who} an owner?`,
          message: "Owners manage seats, settings and deletion.",
          confirmLabel: "Make owner",
        },
      });
    if (m.role === "owner")
      items.push({
        label: "Make member",
        onClick: () => setRoleOf(m, "member"),
        confirm: {
          title: `Make ${who} a member?`,
          confirmLabel: "Make member",
        },
      });
    if (!self && m.role !== "pending")
      items.push({
        label: "Kick",
        danger: true,
        onClick: () => remove(m),
        confirm: {
          title: `Kick ${who}?`,
          message:
            "Nothing is revoked: they still know every channel secret they saw. The response lists what to rotate.",
          confirmLabel: "Kick",
          danger: true,
        },
      });
    return items;
  };

  return (
    <Section
      title="Members"
      description="Kicking or leaving revokes nothing: the person still knows every channel secret they saw. The response lists what to rotate."
      actions={
        <>
          {owner && <Button onClick={add.open}>Add member</Button>}
          {admin && (
            <Button variant="default" onClick={appoint.open}>
              Appoint owner
            </Button>
          )}
        </>
      }
    >
      {act.error && !add.opened && !appoint.opened && (
        <Notice kind="error">{act.error}</Notice>
      )}
      {kicked && <RotationNotice rotate={kicked.rotate} who={kicked.who} />}
      <DataTable
        columns={[
          { key: "login", label: "Login" },
          { key: "role", label: "Role" },
          { key: "since", label: "Since" },
        ]}
        rows={list.data ? seated : undefined}
        loading={list.loading}
        error={list.error}
        rowKey={(m) => m.id}
        minWidth={520}
        empty={{ title: "No seats yet." }}
        render={(m) => {
          const self = m.id === me?.id;
          return (
            <>
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
                {owner && m.role === "pending" && (
                  <Button
                    ml="sm"
                    size="compact-sm"
                    variant="default"
                    disabled={act.busy}
                    onClick={() => void setRoleOf(m, "member")}
                  >
                    Approve
                  </Button>
                )}
              </Table.Td>
              <Table.Td>{fmtTime(m.decidedAt ?? m.requestedAt)}</Table.Td>
            </>
          );
        }}
        actions={
          owner
            ? (m) => <RowMenu name={m.login ?? m.id} items={rowItems(m)} />
            : undefined
        }
      />
      <ResourceDrawer
        opened={add.opened}
        onClose={add.close}
        title="Add member"
        submitLabel="Add member"
        onSubmit={submitAdd}
        busy={act.busy}
        disabled={!add.form.login.trim()}
        error={add.opened ? act.error : null}
      >
        <TextInput
          label="GitHub login"
          description="They must already be a platform member."
          placeholder="octocat"
          value={add.form.login}
          onChange={(e) => add.patch({ login: e.currentTarget.value })}
          required
          maxLength={100}
          autoComplete="off"
          spellCheck={false}
          data-autofocus
        />
        <NativeSelect
          label="Role"
          value={add.form.role}
          onChange={(e) =>
            add.patch({ role: e.currentTarget.value as "member" | "owner" })
          }
          data={["member", "owner"]}
        />
      </ResourceDrawer>
      <ResourceDrawer
        opened={appoint.opened}
        onClose={appoint.close}
        title="Appoint an owner"
        submitLabel="Appoint owner"
        onSubmit={submitAppoint}
        busy={act.busy}
        disabled={!appoint.form.id}
        error={appoint.opened ? act.error : null}
      >
        <NativeSelect
          label="Platform member"
          description="Any platform member (yourself included); they need not be seated yet."
          value={appoint.form.id}
          onChange={(e) => appoint.patch({ id: e.currentTarget.value })}
          data={[
            { value: "", label: "— choose —" },
            ...appointable.map((m) => ({ value: m.id, label: m.login })),
          ]}
        />
      </ResourceDrawer>
    </Section>
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
  const create = useDrawerForm(() => ({ title: "", bodyMd: "" }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() =>
      api.createDiscussion(team.id, {
        title: create.form.title.trim(),
        bodyMd: create.form.bodyMd,
      }),
    );
    if (!r) return;
    create.close();
    notify.created("discussion");
    void nav(discussionUrl(team.id, r.id));
  };
  return (
    <Section
      title="Discussions"
      actions={
        canWrite && <Button onClick={create.open}>New discussion</Button>
      }
    >
      <DataTable
        columns={[
          { key: "title", label: "Title" },
          { key: "by", label: "By" },
          { key: "updated", label: "Updated" },
        ]}
        rows={list.data}
        loading={list.loading}
        error={list.error}
        rowKey={(d) => d.id}
        minWidth={480}
        empty={{ title: "No discussions yet." }}
        render={(d) => (
          <>
            <NameCell to={discussionUrl(team.id, d.id)}>{d.title}</NameCell>
            <Table.Td>{d.createdBy ?? "—"}</Table.Td>
            <Table.Td>{fmtTime(d.updatedAt)}</Table.Td>
          </>
        )}
      />
      <ResourceDrawer
        opened={create.opened}
        onClose={create.close}
        title="New discussion"
        submitLabel="Create discussion"
        onSubmit={submit}
        busy={act.busy}
        disabled={!create.form.title.trim()}
        error={create.opened ? act.error : null}
        size="lg"
      >
        <DiscussionFields
          title={create.form.title}
          bodyMd={create.form.bodyMd}
          onChange={(p) => create.patch(p)}
        />
      </ResourceDrawer>
    </Section>
  );
}

/** Title + markdown body: a discussion or an issue draft. */
export function DiscussionFields({
  title,
  bodyMd,
  onChange,
  bodyLabel = "Body",
  extra,
}: {
  title: string;
  bodyMd: string;
  onChange: (p: { title?: string; bodyMd?: string }) => void;
  bodyLabel?: string;
  extra?: ReactNode;
}) {
  return (
    <Stack gap="md">
      <TextInput
        label="Title"
        value={title}
        onChange={(e) => onChange({ title: e.currentTarget.value })}
        required
        maxLength={200}
        autoComplete="off"
        data-autofocus
      />
      {extra}
      <MdField
        label={bodyLabel}
        value={bodyMd}
        onChange={(bodyMd) => onChange({ bodyMd })}
      />
    </Stack>
  );
}
