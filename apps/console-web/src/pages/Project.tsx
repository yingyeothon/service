import {
  Anchor,
  Button,
  Code,
  Drawer,
  Group,
  NativeSelect,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
} from "@mantine/core";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { Crumbs } from "../components/Crumbs";
import { DataTable, NameCell, NumCell } from "../components/DataTable";
import { EnumFilter, FilterBar } from "../components/FilterBar";
import { Loading, PageSkeleton } from "../components/Loading";
import { Markdown } from "../components/Markdown";
import { MdField } from "../components/MdField";
import { NameDescriptionFields } from "../components/NameDescriptionFields";
import { PageHeader, type HeaderAction } from "../components/PageHeader";
import { ReadOnlyBanner } from "../components/ReadOnlyBanner";
import {
  FormFooter,
  ResourceDrawer,
  useDrawerForm,
} from "../components/ResourceDrawer";
import { RowMenu } from "../components/RowMenu";
import { Section } from "../components/Section";
import { Badge, CopyField, Notice } from "../components/ui";
import { useConfirm } from "../lib/confirm";
import { fmtRelative, fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { useAction, useApiQuery } from "../lib/query";
import { issueUrl, projectUrl, useTeamStanding } from "../lib/team";
import type {
  ChannelStatus,
  IssueStatus,
  ProjectDetail,
  Version,
  VersionLink,
} from "../types";
import { ISSUE_TONE, VersionSelect } from "./Issue";
import { SITE_SHARED_ORIGIN_WARNING } from "./Site";
import { DiscussionFields } from "./Team";

const TABS = ["channels", "catalog", "assets", "sites", "versions", "issues"];

export function ProjectPage() {
  const { team: teamId = "", prj = "", tab = "channels" } = useParams();
  const nav = useNavigate();
  const t = useTeamStanding(teamId);
  const p = useApiQuery(["project", prj], () => api.project(prj));
  const act = useAction();
  const confirm = useConfirm();
  const project = p.data;
  const edit = useDrawerForm(() => ({
    name: project?.name ?? "",
    description: project?.description ?? "",
  }));

  if (p.error)
    return (
      <>
        <Crumbs crumbs={{ teamId, teamName: t.team?.name ?? null }} />
        <PageHeader />
        <Notice kind="error">{p.error}</Notice>
      </>
    );
  if (!project)
    return (
      <>
        <Crumbs crumbs={{ teamId, teamName: t.team?.name ?? null }} />
        <PageHeader />
        <PageSkeleton />
      </>
    );
  const canWrite = t.canWrite;
  const canDelete = t.owner || t.standing === "admin";

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body: { name?: string; description?: string | null } = {};
    const name = edit.form.name.trim();
    if (name !== project.name) body.name = name;
    if (edit.form.description !== (project.description ?? ""))
      body.description =
        edit.form.description === "" ? null : edit.form.description;
    if (Object.keys(body).length === 0) {
      edit.close();
      return;
    }
    const r = await act.run(() => api.updateProject(project.id, body));
    if (!r) return;
    p.set({ ...project, ...r });
    edit.close();
    notify.saved("project");
  };
  const remove = async () => {
    const ok = await act.run(async () => {
      await api.deleteProject(project.id);
      return true;
    });
    if (!ok) return;
    notify.deleted("project");
    void nav(`/teams/${encodeURIComponent(project.teamId)}`);
  };
  const actions: HeaderAction[] = [];
  if (canWrite)
    actions.push({
      label: "Edit",
      onClick: () => {
        act.clear();
        edit.open();
      },
    });
  // A seatless platform admin may delete but not edit (see Team).
  if (canDelete && !canWrite)
    actions.push({
      label: "Delete project",
      danger: true,
      disabled: act.busy,
      onClick: async () => {
        const r = await confirm({
          title: `Delete ${project.name}?`,
          message:
            "Refused while a channel, app, bundle or site still belongs to it.",
          confirmLabel: "Delete project",
          danger: true,
        });
        if (r.ok) await remove();
      },
    });

  return (
    <>
      <Crumbs
        crumbs={{ teamId: project.teamId, teamName: project.teamName }}
        current={project.name}
      />
      <PageHeader
        title={project.name}
        badges={!canWrite && !t.loading && <Badge tone="warn">read-only</Badge>}
        meta={
          <>
            Created by {project.createdBy ?? "—"} · {fmtTime(project.createdAt)}{" "}
            · {project.counts.channels} channel(s), {project.counts.apps}{" "}
            app(s), {project.counts.bundles} bundle(s), {project.counts.sites}{" "}
            site(s), {project.counts.versions} version(s),{" "}
            {project.counts.issues} issue(s) · id <Code>{project.id}</Code>
          </>
        }
        actions={actions}
      />
      {!canWrite && !t.loading && <ReadOnlyBanner />}
      {act.error && !edit.opened && <Notice kind="error">{act.error}</Notice>}
      {project.description && <Markdown text={project.description} />}
      <Tabs
        value={TABS.includes(tab) ? tab : "channels"}
        onChange={(v) => void nav(projectUrl(teamId, prj, v ?? undefined))}
        keepMounted={false}
        mb="md"
      >
        <Tabs.List>
          <Tabs.Tab value="channels">Channels</Tabs.Tab>
          <Tabs.Tab value="catalog">Catalog</Tabs.Tab>
          <Tabs.Tab value="assets">Assets</Tabs.Tab>
          <Tabs.Tab value="sites">Sites</Tabs.Tab>
          <Tabs.Tab value="versions">Versions</Tabs.Tab>
          <Tabs.Tab value="issues">Issues</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="channels" pt="lg">
          <ChannelsTab
            project={project}
            canWrite={canWrite}
            onCounts={p.reload}
          />
        </Tabs.Panel>
        <Tabs.Panel value="catalog" pt="lg">
          <CatalogTab project={project} canWrite={canWrite} />
        </Tabs.Panel>
        <Tabs.Panel value="assets" pt="lg">
          <AssetsTab project={project} canWrite={canWrite} />
        </Tabs.Panel>
        <Tabs.Panel value="sites" pt="lg">
          <SitesTab project={project} canWrite={canWrite} />
        </Tabs.Panel>
        <Tabs.Panel value="versions" pt="lg">
          <VersionsTab project={project} canWrite={canWrite} />
        </Tabs.Panel>
        <Tabs.Panel value="issues" pt="lg">
          <IssuesTab project={project} canWrite={canWrite} />
        </Tabs.Panel>
      </Tabs>
      <ResourceDrawer
        opened={edit.opened}
        onClose={edit.close}
        title="Edit project"
        submitLabel="Save"
        onSubmit={save}
        busy={act.busy}
        disabled={!edit.form.name.trim()}
        error={edit.opened ? act.error : null}
        danger={
          canDelete
            ? {
                label: "Delete project",
                description:
                  "Deleting a project is refused while a channel, app, bundle or site still belongs to it — including channels deleted less than a day ago, until the sweep purges them.",
                onConfirm: remove,
                disabled: act.busy,
              }
            : undefined
        }
      >
        <div>
          <CopyField label="Project id" value={project.id} />
          <CopyField label="Team id" value={project.teamId} />
          <Text size="xs" c="dimmed">
            For the CLI: <code>yyt project use {project.id}</code> or{" "}
            <code>{`.yyt.json {"team":"${project.teamId}","project":"${project.id}"}`}</code>
            .
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

const STATUS_TONE: Record<ChannelStatus, string> = {
  active: "ok",
  expired: "warn",
  disabled: "danger",
};

function ChannelsTab({
  project,
  canWrite,
  onCounts,
}: {
  project: ProjectDetail;
  canWrite: boolean;
  /** The header counts come from the project row: refresh it after a delete. */
  onCounts: () => Promise<void>;
}) {
  const list = useApiQuery(["project", project.id, "channels"], () =>
    api.projectChannels(project.id),
  );
  const act = useAction();
  const extend = async (id: string) => {
    if (await act.run(() => api.extendChannel(id))) {
      notify.done("Channel extended");
      await list.reload();
    }
  };
  const remove = async (id: string) => {
    if (
      await act.run(async () => {
        await api.deleteChannel(id);
        return true;
      })
    ) {
      notify.deleted("channel");
      await Promise.all([list.reload(), onCounts()]);
    }
  };
  return (
    <Section
      title="Channels"
      description="Channels expire 7 days after creation; extend them from the row menu or the detail page (up to 28 days ahead)."
      actions={
        canWrite && (
          <Button
            component={Link}
            variant="default"
            to={`${projectUrl(project.teamId, project.id)}/channels/new`}
          >
            New channel
          </Button>
        )
      }
    >
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <DataTable
        columns={[
          { key: "name", label: "Name" },
          { key: "kind", label: "Kind" },
          { key: "id", label: "Id" },
          { key: "status", label: "Status" },
          { key: "expires", label: "Expires" },
        ]}
        rows={list.data}
        loading={list.loading}
        error={list.error}
        rowKey={(c) => c.id}
        empty={{
          title: "No channels yet.",
          hint: canWrite
            ? "An auth channel comes first; topic, match, lobby and q channels hang off it."
            : undefined,
        }}
        render={(c) => (
          <>
            <NameCell to={`/channels/${encodeURIComponent(c.id)}`}>
              {c.name}
            </NameCell>
            <Table.Td>{c.kind}</Table.Td>
            <Table.Td>
              <Code>{c.id}</Code>
            </Table.Td>
            <Table.Td>
              <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
            </Table.Td>
            <Table.Td title={fmtTime(c.expiresAt)}>
              {fmtRelative(c.expiresAt)}
            </Table.Td>
          </>
        )}
        actions={
          canWrite
            ? (c) => (
                <RowMenu
                  name={c.name}
                  items={[
                    {
                      label: "Extend +7 days",
                      onClick: () => extend(c.id),
                      disabled: act.busy,
                    },
                    {
                      label: "Delete channel",
                      danger: true,
                      disabled: act.busy,
                      onClick: () => remove(c.id),
                      confirm: {
                        title: `Delete ${c.name}?`,
                        message:
                          "Sockets on it are closed and its credentials stop working.",
                        confirmLabel: "Delete channel",
                        danger: true,
                      },
                    },
                  ]}
                />
              )
            : undefined
        }
      />
    </Section>
  );
}

/**
 * The three list-and-create tabs (catalog apps, asset bundles, sites) are one
 * screen with different columns: a section with the `New <noun>` button, a
 * drawer with a name and one more field, and the table.
 */
function ResourceListTab<T extends { id: string }>({
  project,
  canWrite,
  queryKey,
  load,
  create,
  noun,
  title,
  intro,
  warn,
  namePlaceholder,
  second,
  columns,
  row,
  emptyText,
}: {
  project: ProjectDetail;
  canWrite: boolean;
  queryKey: string;
  load: (projectId: string) => Promise<T[]>;
  /**
   * `second` arrives trimmed; empty when the optional field was left blank.
   * Must resolve to the created row: `useAction.run` reports failure as
   * `undefined`, so a 204 here would read as a failed create.
   */
  create: (projectId: string, name: string, second: string) => Promise<object>;
  /** "app" → `New app`, `Create app`, "App created". */
  noun: string;
  title: string;
  intro: ReactNode;
  warn?: ReactNode;
  namePlaceholder: string;
  second: {
    label: string;
    placeholder: string;
    required: boolean;
    maxLength: number;
  };
  columns: { key: string; label: string }[];
  /** The cells after the name cell. */
  row: (item: T) => ReactNode;
  emptyText: string;
}) {
  const list = useApiQuery(["project", project.id, queryKey], () =>
    load(project.id),
  );
  const act = useAction();
  const drawer = useDrawerForm(() => ({ name: "", extra: "" }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() =>
      create(project.id, drawer.form.name.trim(), drawer.form.extra.trim()),
    );
    if (!r) return;
    drawer.close();
    notify.created(noun);
    await list.reload();
  };
  const canSubmit =
    !!drawer.form.name.trim() &&
    (!second.required || !!drawer.form.extra.trim());
  return (
    <Section
      title={title}
      description={intro}
      actions={
        canWrite && (
          <Button variant="default" onClick={drawer.open}>
            New {noun}
          </Button>
        )
      }
    >
      {warn}
      {act.error && !drawer.opened && <Notice kind="error">{act.error}</Notice>}
      <DataTable
        columns={columns}
        rows={list.data}
        loading={list.loading}
        error={list.error}
        rowKey={(item) => item.id}
        empty={{ title: emptyText }}
        render={row}
      />
      <ResourceDrawer
        opened={drawer.opened}
        onClose={drawer.close}
        title={`New ${noun}`}
        submitLabel={`Create ${noun}`}
        onSubmit={submit}
        busy={act.busy}
        disabled={!canSubmit}
        error={drawer.opened ? act.error : null}
      >
        <TextInput
          label="Name"
          placeholder={namePlaceholder}
          value={drawer.form.name}
          onChange={(e) => drawer.patch({ name: e.currentTarget.value })}
          required
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          data-autofocus
        />
        <TextInput
          label={second.label}
          placeholder={second.placeholder}
          value={drawer.form.extra}
          onChange={(e) => drawer.patch({ extra: e.currentTarget.value })}
          required={second.required}
          maxLength={second.maxLength}
          autoComplete="off"
        />
      </ResourceDrawer>
    </Section>
  );
}

function CatalogTab(props: { project: ProjectDetail; canWrite: boolean }) {
  return (
    <ResourceListTab
      {...props}
      queryKey="apps"
      load={api.projectCatalogApps}
      create={(prj, name, path) => api.createCatalogApp(prj, { name, path })}
      noun="app"
      title="Catalog"
      intro="Binary distribution: apps hold build artifacts served from the public CDN."
      namePlaceholder="name (e.g. my-game)"
      second={{
        label: "Application id",
        placeholder: "life.yyt.my-game",
        required: true,
        maxLength: 200,
      }}
      columns={[
        { key: "name", label: "App" },
        { key: "path", label: "Application id" },
        { key: "by", label: "Created by" },
        { key: "updated", label: "Updated" },
      ]}
      row={(a) => (
        <>
          <NameCell to={`/catalog/apps/${encodeURIComponent(a.id)}`}>
            {a.name}
          </NameCell>
          <Table.Td>
            <Code>{a.path}</Code>
          </Table.Td>
          <Table.Td>{a.createdBy ?? "—"}</Table.Td>
          <Table.Td>{fmtTime(a.updatedAt)}</Table.Td>
        </>
      )}
      emptyText="No apps yet."
    />
  );
}

/** An optional description travels only when the writer typed one. */
const withDescription = (name: string, description: string) => ({
  name,
  ...(description ? { description } : {}),
});

function AssetsTab(props: { project: ProjectDetail; canWrite: boolean }) {
  return (
    <ResourceListTab
      {...props}
      queryKey="bundles"
      load={api.projectAssetBundles}
      create={(prj, name, description) =>
        api.createAssetBundle(prj, withDescription(name, description))
      }
      noun="bundle"
      title="Assets"
      intro="Game content on the public CDN: maps, tilesets, sounds. Every object is versioned, world-readable and cached forever — publishing a fix means uploading a new version and pointing a lobby channel’s map URL at it."
      namePlaceholder="name (e.g. dungeon-maps)"
      second={{
        label: "Description",
        placeholder: "optional",
        required: false,
        maxLength: 2000,
      }}
      columns={[
        { key: "name", label: "Bundle" },
        { key: "desc", label: "Description" },
        { key: "by", label: "Created by" },
        { key: "updated", label: "Updated" },
      ]}
      row={(b) => (
        <>
          <NameCell to={`/assets/${encodeURIComponent(b.id)}`}>
            {b.name}
          </NameCell>
          <Table.Td>{b.description ?? "—"}</Table.Td>
          <Table.Td>{b.createdBy ?? "—"}</Table.Td>
          <Table.Td>{fmtTime(b.updatedAt)}</Table.Td>
        </>
      )}
      emptyText="No asset bundles yet."
    />
  );
}

function SitesTab(props: { project: ProjectDetail; canWrite: boolean }) {
  return (
    <ResourceListTab
      {...props}
      queryKey="sites"
      load={api.projectSites}
      create={(prj, name, description) =>
        api.createSite(prj, withDescription(name, description))
      }
      noun="site"
      title="Sites"
      intro="Static web builds (a browser game client, a landing page) served at the shared static host under a random path. One live tree per site: a deploy replaces the previous files."
      warn={<Notice kind="warn">{SITE_SHARED_ORIGIN_WARNING}</Notice>}
      namePlaceholder="name (e.g. game-web)"
      second={{
        label: "Description",
        placeholder: "optional",
        required: false,
        maxLength: 2000,
      }}
      columns={[
        { key: "name", label: "Site" },
        { key: "url", label: "URL" },
        { key: "live", label: "Live" },
        { key: "updated", label: "Updated" },
      ]}
      row={(s) => (
        <>
          <NameCell to={`/sites/${encodeURIComponent(s.id)}`}>
            {s.name}
          </NameCell>
          <Table.Td>
            <Anchor
              href={s.publicUrl}
              size="sm"
              target="_blank"
              rel="noopener noreferrer"
            >
              {s.publicUrl}
            </Anchor>
          </Table.Td>
          <Table.Td>
            {s.busy ? (
              <Badge tone="warn">deploying</Badge>
            ) : s.currentDeployId ? (
              <Badge tone="ok">live</Badge>
            ) : (
              <Badge tone="neutral">empty</Badge>
            )}
          </Table.Td>
          <Table.Td>{fmtTime(s.updatedAt)}</Table.Td>
        </>
      )}
      emptyText="No sites yet."
    />
  );
}

/* ---- versions ------------------------------------------------------------ */

function linkLabel(l: VersionLink): string {
  return l.kind === "artifact"
    ? `artifact ${l.artifactId ?? ""}`
    : `asset ${l.bundleId ?? ""} @ ${l.assetVersion ?? ""}`;
}

/**
 * One version's note and links, in a drawer. A link may only point inside
 * the same project (the API checks); the pickers list what the project has.
 * Two forms live here, so it is a plain drawer rather than a `ResourceDrawer`.
 */
export function VersionDrawer({
  project,
  version,
  canWrite,
  onChanged,
  onClose,
}: {
  project: ProjectDetail;
  version: Version | null;
  canWrite: boolean;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  return (
    <Drawer
      opened={version !== null}
      onClose={onClose}
      title={version ? `Version ${version.name}` : ""}
      size="lg"
    >
      {version && (
        <VersionBody
          key={version.id}
          project={project}
          version={version}
          canWrite={canWrite}
          onChanged={onChanged}
        />
      )}
    </Drawer>
  );
}

function VersionBody({
  project,
  version,
  canWrite,
  onChanged,
}: {
  project: ProjectDetail;
  version: Version;
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const detail = useApiQuery(["version", project.id, version.id], () =>
    api.version(project.id, version.id),
  );
  const apps = useApiQuery(["project", project.id, "apps"], () =>
    api.projectCatalogApps(project.id),
  );
  const bundles = useApiQuery(["project", project.id, "bundles"], () =>
    api.projectAssetBundles(project.id),
  );
  const act = useAction();
  const [note, setNote] = useState<string | null>(null);
  const [kind, setKind] = useState<"artifact" | "asset_version">("artifact");
  const [appId, setAppId] = useState("");
  const [artifactId, setArtifactId] = useState("");
  const [bundleId, setBundleId] = useState("");
  const [assetVersion, setAssetVersion] = useState("");
  const artifacts = useApiQuery(
    ["catalog", "app", appId, "artifacts"],
    () => api.catalogArtifacts(appId),
    { enabled: kind === "artifact" && appId !== "" },
  );
  const bundle = useApiQuery(
    ["assets", "bundle", bundleId],
    () => api.assetBundle(bundleId),
    { enabled: kind === "asset_version" && bundleId !== "" },
  );

  const saveNote = async (e: FormEvent) => {
    e.preventDefault();
    if (note === null) return;
    const r = await act.run(() =>
      api.updateVersion(project.id, version.id, note === "" ? null : note),
    );
    if (r) {
      setNote(null);
      notify.saved("release note");
      await detail.reload();
      await onChanged();
    }
  };
  const addLink = async (e: FormEvent) => {
    e.preventDefault();
    const body =
      kind === "artifact"
        ? ({ kind, artifactId } as const)
        : ({ kind, bundleId, assetVersion } as const);
    if (await act.run(() => api.addVersionLink(project.id, version.id, body))) {
      setArtifactId("");
      setAssetVersion("");
      notify.done("Link added");
      await detail.reload();
      await onChanged(); // list counts
    }
  };
  const removeLink = async (id: string) => {
    if (
      await act.run(async () => {
        await api.removeVersionLink(project.id, version.id, id);
        return true;
      })
    ) {
      notify.done("Link removed");
      await detail.reload();
      await onChanged(); // list counts
    }
  };
  const canAdd =
    kind === "artifact"
      ? artifactId !== ""
      : bundleId !== "" && assetVersion !== "";

  return (
    <Stack gap="lg">
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <Text size="sm" c="dimmed">
        {version.createdBy ?? "—"} · {fmtTime(version.createdAt)}
      </Text>
      {canWrite ? (
        <form onSubmit={(e) => void saveNote(e)}>
          <Stack gap="sm">
            <MdField
              label="Release note"
              value={note ?? version.note ?? ""}
              onChange={setNote}
              minRows={3}
            />
            <FormFooter
              submitLabel="Save note"
              busy={act.busy}
              disabled={note === null}
            />
          </Stack>
        </form>
      ) : (
        <Markdown text={version.note ?? ""} />
      )}
      <Section title="Links">
        {detail.error && <Notice kind="error">{detail.error}</Notice>}
        {!detail.data ? (
          <Loading />
        ) : detail.data.links.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing linked yet.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={420}>
            <Table>
              <Table.Tbody>
                {detail.data.links.map((l) => (
                  <Table.Tr key={l.id}>
                    <Table.Td>
                      <Code>{linkLabel(l)}</Code>
                    </Table.Td>
                    <Table.Td>{fmtTime(l.createdAt)}</Table.Td>
                    <Table.Td style={{ textAlign: "right" }}>
                      {canWrite && (
                        <RowMenu
                          name={linkLabel(l)}
                          items={[
                            {
                              label: "Unlink",
                              danger: true,
                              disabled: act.busy,
                              onClick: () => removeLink(l.id),
                              confirm: {
                                title: "Unlink?",
                                message: linkLabel(l),
                                confirmLabel: "Unlink",
                                danger: true,
                              },
                            },
                          ]}
                        />
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
        {canWrite && (
          <form onSubmit={(e) => void addLink(e)}>
            <Group align="end" wrap="wrap" mt="md">
              <NativeSelect
                label="Link"
                value={kind}
                onChange={(e) =>
                  setKind(e.target.value as "artifact" | "asset_version")
                }
                data={[
                  { value: "artifact", label: "catalog artifact" },
                  { value: "asset_version", label: "asset version" },
                ]}
              />
              {kind === "artifact" ? (
                <>
                  <NativeSelect
                    label="App"
                    value={appId}
                    onChange={(e) => {
                      setAppId(e.target.value);
                      setArtifactId("");
                    }}
                    data={[
                      { value: "", label: "— choose —" },
                      ...(apps.data ?? []).map((a) => ({
                        value: a.id,
                        label: a.name,
                      })),
                    ]}
                  />
                  <NativeSelect
                    label="Artifact"
                    value={artifactId}
                    onChange={(e) => setArtifactId(e.target.value)}
                    data={[
                      { value: "", label: "— choose —" },
                      ...(artifacts.data ?? []).map((a) => ({
                        value: a.id,
                        label: `${a.tags.version ?? "?"} ${a.platform} (${fmtTime(a.createdAt)})`,
                      })),
                    ]}
                  />
                </>
              ) : (
                <>
                  <NativeSelect
                    label="Bundle"
                    value={bundleId}
                    onChange={(e) => {
                      setBundleId(e.target.value);
                      setAssetVersion("");
                    }}
                    data={[
                      { value: "", label: "— choose —" },
                      ...(bundles.data ?? []).map((b) => ({
                        value: b.id,
                        label: b.name,
                      })),
                    ]}
                  />
                  <NativeSelect
                    label="Version"
                    value={assetVersion}
                    onChange={(e) => setAssetVersion(e.target.value)}
                    data={[
                      { value: "", label: "— choose —" },
                      ...(bundle.data?.versions ?? []).map((v) => ({
                        value: v.version,
                        label: v.version,
                      })),
                    ]}
                  />
                </>
              )}
              <Button
                type="submit"
                variant="default"
                disabled={act.busy || !canAdd}
              >
                Add link
              </Button>
            </Group>
          </form>
        )}
      </Section>
    </Stack>
  );
}

function VersionsTab({
  project,
  canWrite,
}: {
  project: ProjectDetail;
  canWrite: boolean;
}) {
  const list = useApiQuery(["versions", project.id], () =>
    api.versions(project.id),
  );
  const act = useAction();
  const create = useDrawerForm(() => ({ name: "" }));
  const [open, setOpen] = useState<Version | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (
      await act.run(() =>
        api.createVersion(project.id, { name: create.form.name.trim() }),
      )
    ) {
      create.close();
      notify.created("version");
      await list.reload();
    }
  };
  const bump = async (part: "patch" | "minor" | "major") => {
    const r = await act.run(() => api.bumpVersion(project.id, part));
    if (r) {
      notify.created("version");
      await list.reload();
    }
  };
  const remove = async (v: Version) => {
    if (
      await act.run(async () => {
        await api.deleteVersion(project.id, v.id);
        return true;
      })
    ) {
      notify.deleted("version");
      await list.reload();
    }
  };

  return (
    <Section
      title="Versions"
      description={
        <>
          Versions are free strings, unique within the project. <b>Bump</b>{" "}
          takes the greatest semver-shaped one (<Code>1.2.3</Code> or{" "}
          <Code>v1.2.3</Code>) and adds one; a version links to the artifacts
          and asset versions that make it up.
        </>
      }
      actions={
        canWrite && (
          <>
            {(["patch", "minor", "major"] as const).map((part) => (
              <Button
                key={part}
                variant="default"
                disabled={act.busy}
                onClick={() => void bump(part)}
              >
                Bump {part}
              </Button>
            ))}
            <Button variant="default" onClick={create.open}>
              New version
            </Button>
          </>
        )
      }
    >
      {act.error && !create.opened && <Notice kind="error">{act.error}</Notice>}
      <DataTable
        columns={[
          { key: "name", label: "Version" },
          { key: "note", label: "Note" },
          { key: "artifacts", label: "Artifacts", align: "right" },
          { key: "assets", label: "Assets", align: "right" },
          { key: "by", label: "By" },
          { key: "created", label: "Created" },
        ]}
        rows={list.data}
        loading={list.loading}
        error={list.error}
        rowKey={(v) => v.id}
        minWidth={560}
        empty={{ title: "No versions yet." }}
        render={(v) => (
          <>
            <Table.Td>
              <Anchor
                component="button"
                type="button"
                size="sm"
                fw={500}
                onClick={() => setOpen(v)}
              >
                {v.name}
              </Anchor>
            </Table.Td>
            <Table.Td>
              <Text size="sm" lineClamp={1}>
                {v.note ?? "—"}
              </Text>
            </Table.Td>
            <NumCell>{v.artifactCount}</NumCell>
            <NumCell>{v.assetCount}</NumCell>
            <Table.Td>{v.createdBy ?? "—"}</Table.Td>
            <Table.Td>{fmtTime(v.createdAt)}</Table.Td>
          </>
        )}
        actions={
          canWrite
            ? (v) => (
                <RowMenu
                  name={v.name}
                  items={[
                    {
                      label: "Delete version",
                      danger: true,
                      disabled: act.busy,
                      onClick: () => remove(v),
                      confirm: {
                        title: `Delete ${v.name}?`,
                        message: "Its links go with it; issues keep the id.",
                        confirmLabel: "Delete version",
                        danger: true,
                      },
                    },
                  ]}
                />
              )
            : undefined
        }
      />
      <VersionDrawer
        project={project}
        version={
          open ? (list.data?.find((v) => v.id === open.id) ?? open) : null
        }
        canWrite={canWrite}
        onChanged={list.reload}
        onClose={() => setOpen(null)}
      />
      <ResourceDrawer
        opened={create.opened}
        onClose={create.close}
        title="New version"
        submitLabel="Create version"
        onSubmit={submit}
        busy={act.busy}
        disabled={!create.form.name.trim()}
        error={create.opened ? act.error : null}
      >
        <TextInput
          label="Name"
          placeholder="v1.0.0"
          value={create.form.name}
          onChange={(e) => create.patch({ name: e.currentTarget.value })}
          required
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          data-autofocus
        />
      </ResourceDrawer>
    </Section>
  );
}

/* ---- issues -------------------------------------------------------------- */

function IssuesTab({
  project,
  canWrite,
}: {
  project: ProjectDetail;
  canWrite: boolean;
}) {
  const [status, setStatus] = useState<IssueStatus | "">("open");
  const list = useApiQuery(["issues", project.id, status], () =>
    api.issues(project.id, status || undefined),
  );
  const versions = useApiQuery(["versions", project.id], () =>
    api.versions(project.id),
  );
  const act = useAction();
  const nav = useNavigate();
  const create = useDrawerForm(() => ({
    title: "",
    bodyMd: "",
    versionId: null as string | null,
  }));
  const versionName = (id: string | null) =>
    id ? (versions.data?.find((v) => v.id === id)?.name ?? id) : "—";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() =>
      api.createIssue(project.id, {
        title: create.form.title.trim(),
        bodyMd: create.form.bodyMd,
        versionId: create.form.versionId,
      }),
    );
    if (!r) return;
    create.close();
    notify.created("issue");
    void nav(issueUrl(project.teamId, project.id, r.number));
  };

  return (
    <Section
      title="Issues"
      actions={
        canWrite && (
          <Button variant="default" onClick={create.open}>
            New issue
          </Button>
        )
      }
    >
      <FilterBar>
        <EnumFilter
          label="Status"
          value={status}
          options={[
            { value: "open", label: "Open" },
            { value: "closed", label: "Closed" },
            { value: "", label: "All" },
          ]}
          onChange={(v) => setStatus(v as IssueStatus | "")}
        />
      </FilterBar>
      {act.error && !create.opened && <Notice kind="error">{act.error}</Notice>}
      <DataTable
        columns={[
          { key: "n", label: "#", align: "right" },
          { key: "title", label: "Title" },
          { key: "status", label: "Status" },
          { key: "version", label: "Version" },
          { key: "by", label: "By" },
          { key: "updated", label: "Updated" },
        ]}
        rows={list.data}
        loading={list.loading}
        error={list.error}
        rowKey={(i) => i.id}
        empty={{ title: `No ${status || ""} issues.`.replace("  ", " ") }}
        render={(i) => (
          <>
            <NumCell>{i.number}</NumCell>
            <NameCell to={issueUrl(project.teamId, project.id, i.number)}>
              {i.title}
            </NameCell>
            <Table.Td>
              <Badge tone={ISSUE_TONE[i.status]}>{i.status}</Badge>
            </Table.Td>
            <Table.Td>{versionName(i.versionId)}</Table.Td>
            <Table.Td>{i.createdBy ?? "—"}</Table.Td>
            <Table.Td>{fmtTime(i.updatedAt)}</Table.Td>
          </>
        )}
      />
      <ResourceDrawer
        opened={create.opened}
        onClose={create.close}
        title="New issue"
        submitLabel="Open issue"
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
          bodyLabel="Description"
          extra={
            <VersionSelect
              versions={versions.data ?? []}
              value={create.form.versionId}
              onChange={(versionId) => create.patch({ versionId })}
            />
          }
        />
      </ResourceDrawer>
    </Section>
  );
}
