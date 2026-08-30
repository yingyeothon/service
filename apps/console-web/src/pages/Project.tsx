import {
  Anchor,
  Button,
  Card,
  Code,
  Group,
  NativeSelect,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { Crumbs } from "../components/Crumbs";
import { Markdown } from "../components/Markdown";
import { MdField } from "../components/MdField";
import { Badge, Confirm, CopyField, Notice, Spinner } from "../components/ui";
import { fmtRelative, fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";
import { issueUrl, projectUrl, teamUrl, useTeamStanding } from "../lib/team";
import type {
  ChannelStatus,
  IssueStatus,
  ProjectDetail,
  Version,
  VersionLink,
} from "../types";
import { ISSUE_TONE, VersionSelect } from "./Issue";
import { SITE_SHARED_ORIGIN_WARNING } from "./Site";

const TABS = [
  "channels",
  "catalog",
  "assets",
  "sites",
  "versions",
  "issues",
  "settings",
];

export function ProjectPage() {
  const { team: teamId = "", prj = "", tab = "channels" } = useParams();
  const nav = useNavigate();
  const t = useTeamStanding(teamId);
  const p = useApiQuery(["project", prj], () => api.project(prj));

  if (p.error) return <Notice kind="error">{p.error}</Notice>;
  if (!p.data) return <Spinner />;
  const project = p.data;
  const canWrite = t.canWrite;

  return (
    <>
      <Crumbs
        crumbs={{ teamId: project.teamId, teamName: project.teamName }}
        current={project.name}
      />
      <Group gap="xs" mb="xs" align="center">
        <Title order={2}>{project.name}</Title>
        {!canWrite && !t.loading && <Badge tone="warn">read-only</Badge>}
      </Group>
      <Markdown text={project.description ?? ""} />
      <Text size="xs" c="dimmed" mb="sm">
        Created by {project.createdBy ?? "—"} · {fmtTime(project.createdAt)} ·{" "}
        {project.counts.channels} channel(s), {project.counts.apps} app(s),{" "}
        {project.counts.bundles} bundle(s), {project.counts.sites} site(s),{" "}
        {project.counts.versions} version(s), {project.counts.issues} issue(s)
      </Text>
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
          <Tabs.Tab value="settings">Settings</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="channels" pt="sm">
          <ChannelsTab project={project} canWrite={canWrite} />
        </Tabs.Panel>
        <Tabs.Panel value="catalog" pt="sm">
          <CatalogTab project={project} canWrite={canWrite} />
        </Tabs.Panel>
        <Tabs.Panel value="assets" pt="sm">
          <AssetsTab project={project} canWrite={canWrite} />
        </Tabs.Panel>
        <Tabs.Panel value="sites" pt="sm">
          <SitesTab project={project} canWrite={canWrite} />
        </Tabs.Panel>
        <Tabs.Panel value="versions" pt="sm">
          <VersionsTab project={project} canWrite={canWrite} />
        </Tabs.Panel>
        <Tabs.Panel value="issues" pt="sm">
          <IssuesTab project={project} canWrite={canWrite} />
        </Tabs.Panel>
        <Tabs.Panel value="settings" pt="sm">
          <SettingsTab
            project={project}
            canWrite={canWrite}
            canDelete={t.owner || t.standing === "admin"}
            onChange={p.set}
          />
        </Tabs.Panel>
      </Tabs>
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
}: {
  project: ProjectDetail;
  canWrite: boolean;
}) {
  const list = useApiQuery(["project", project.id, "channels"], () =>
    api.projectChannels(project.id),
  );
  return (
    <>
      <Group justify="space-between" mb="sm">
        <Text size="sm" c="dimmed">
          Channels expire 7 days after creation; extend them from the detail
          page (up to 28 days ahead).
        </Text>
        {canWrite && (
          <Button
            component={Link}
            to={`${projectUrl(project.teamId, project.id)}/channels/new`}
            size="compact-sm"
          >
            New channel
          </Button>
        )}
      </Group>
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <Table.ScrollContainer minWidth={560}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Kind</Table.Th>
                <Table.Th>Id</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Expires</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.data.map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td>
                    <Anchor
                      component={Link}
                      to={`/channels/${encodeURIComponent(c.id)}`}
                      size="sm"
                    >
                      {c.name}
                    </Anchor>
                  </Table.Td>
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
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <Text size="sm" c="dimmed">
          No channels yet.
        </Text>
      )}
    </>
  );
}

function CatalogTab({
  project,
  canWrite,
}: {
  project: ProjectDetail;
  canWrite: boolean;
}) {
  const list = useApiQuery(["project", project.id, "apps"], () =>
    api.projectCatalogApps(project.id),
  );
  const act = useAction();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() =>
      api.createCatalogApp(project.id, {
        name: name.trim(),
        path: path.trim(),
      }),
    );
    if (!r) return;
    setName("");
    setPath("");
    await list.reload();
  };
  return (
    <>
      <Text size="sm" c="dimmed" mb="sm">
        Binary distribution: apps hold build artifacts served from the public
        CDN.
      </Text>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {canWrite && (
        <Card withBorder mb="md" padding="sm">
          <form onSubmit={(e) => void create(e)}>
            <Group align="end" wrap="wrap">
              <TextInput
                label="New app"
                placeholder="name (e.g. my-game)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={64}
              />
              <TextInput
                label="Application id"
                placeholder="life.yyt.my-game"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                required
                maxLength={200}
              />
              <Button
                type="submit"
                disabled={act.busy || !name.trim() || !path.trim()}
              >
                Create app
              </Button>
            </Group>
          </form>
        </Card>
      )}
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <Table.ScrollContainer minWidth={560}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>App</Table.Th>
                <Table.Th>Application id</Table.Th>
                <Table.Th>Created by</Table.Th>
                <Table.Th>Updated</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.data.map((a) => (
                <Table.Tr key={a.id}>
                  <Table.Td>
                    <Anchor
                      component={Link}
                      to={`/catalog/apps/${encodeURIComponent(a.id)}`}
                      size="sm"
                    >
                      {a.name}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>
                    <Code>{a.path}</Code>
                  </Table.Td>
                  <Table.Td>{a.createdBy ?? "—"}</Table.Td>
                  <Table.Td>{fmtTime(a.updatedAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <Text size="sm" c="dimmed">
          No apps yet.
        </Text>
      )}
    </>
  );
}

function AssetsTab({
  project,
  canWrite,
}: {
  project: ProjectDetail;
  canWrite: boolean;
}) {
  const list = useApiQuery(["project", project.id, "bundles"], () =>
    api.projectAssetBundles(project.id),
  );
  const act = useAction();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() =>
      api.createAssetBundle(project.id, {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    );
    if (!r) return;
    setName("");
    setDescription("");
    await list.reload();
  };
  return (
    <>
      <Text size="sm" c="dimmed" mb="sm">
        Game content on the public CDN: maps, tilesets, sounds. Every object is
        versioned, world-readable and cached forever — publishing a fix means
        uploading a new version and pointing a lobby channel&rsquo;s map URL at
        it.
      </Text>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {canWrite && (
        <Card withBorder mb="md" padding="sm">
          <form onSubmit={(e) => void create(e)}>
            <Group align="end" wrap="wrap">
              <TextInput
                label="New bundle"
                placeholder="name (e.g. dungeon-maps)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={64}
              />
              <TextInput
                label="Description"
                placeholder="optional"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
              />
              <Button type="submit" disabled={act.busy || !name.trim()}>
                Create bundle
              </Button>
            </Group>
          </form>
        </Card>
      )}
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <Table.ScrollContainer minWidth={560}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Bundle</Table.Th>
                <Table.Th>Description</Table.Th>
                <Table.Th>Created by</Table.Th>
                <Table.Th>Updated</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.data.map((b) => (
                <Table.Tr key={b.id}>
                  <Table.Td>
                    <Anchor
                      component={Link}
                      to={`/assets/${encodeURIComponent(b.id)}`}
                      size="sm"
                    >
                      {b.name}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>{b.description ?? "—"}</Table.Td>
                  <Table.Td>{b.createdBy ?? "—"}</Table.Td>
                  <Table.Td>{fmtTime(b.updatedAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <Text size="sm" c="dimmed">
          No asset bundles yet.
        </Text>
      )}
    </>
  );
}

function SitesTab({
  project,
  canWrite,
}: {
  project: ProjectDetail;
  canWrite: boolean;
}) {
  const list = useApiQuery(["project", project.id, "sites"], () =>
    api.projectSites(project.id),
  );
  const act = useAction();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() =>
      api.createSite(project.id, {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    );
    if (!r) return;
    setName("");
    setDescription("");
    await list.reload();
  };
  return (
    <>
      <Text size="sm" c="dimmed" mb="sm">
        Static web builds (a browser game client, a landing page) served at the
        shared static host under a random path. One live tree per site: a deploy
        replaces the previous files.
      </Text>
      <Notice kind="warn">{SITE_SHARED_ORIGIN_WARNING}</Notice>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {canWrite && (
        <Card withBorder mb="md" padding="sm">
          <form onSubmit={(e) => void create(e)}>
            <Group align="end" wrap="wrap">
              <TextInput
                label="New site"
                placeholder="name (e.g. game-web)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={64}
              />
              <TextInput
                label="Description"
                placeholder="optional"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
              />
              <Button type="submit" disabled={act.busy || !name.trim()}>
                Create site
              </Button>
            </Group>
          </form>
        </Card>
      )}
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <Table.ScrollContainer minWidth={560}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Site</Table.Th>
                <Table.Th>URL</Table.Th>
                <Table.Th>Live</Table.Th>
                <Table.Th>Updated</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.data.map((s) => (
                <Table.Tr key={s.id}>
                  <Table.Td>
                    <Anchor
                      component={Link}
                      to={`/sites/${encodeURIComponent(s.id)}`}
                      size="sm"
                    >
                      {s.name}
                    </Anchor>
                  </Table.Td>
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
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <Text size="sm" c="dimmed">
          No sites yet.
        </Text>
      )}
    </>
  );
}

/* ---- versions ------------------------------------------------------------ */

function linkLabel(l: VersionLink): string {
  return l.kind === "artifact"
    ? `artifact ${l.artifactId ?? ""}`
    : `asset ${l.bundleId ?? ""} @ ${l.assetVersion ?? ""}`;
}

/**
 * One version's note and links, in a modal. A link may only point inside the
 * same project (the API checks); the pickers list what the project has.
 */
export function VersionModal({
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
      await detail.reload();
      await onChanged(); // list counts
    }
  };
  const canAdd =
    kind === "artifact"
      ? artifactId !== ""
      : bundleId !== "" && assetVersion !== "";

  return (
    <Stack gap="sm">
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <Text size="xs" c="dimmed">
        {version.createdBy ?? "—"} · {fmtTime(version.createdAt)}
      </Text>
      {canWrite ? (
        <form onSubmit={(e) => void saveNote(e)}>
          <Stack gap="xs">
            <MdField
              label="Release note"
              value={note ?? version.note ?? ""}
              onChange={setNote}
              minRows={3}
            />
            <Group>
              <Button
                type="submit"
                size="compact-sm"
                disabled={act.busy || note === null}
              >
                Save note
              </Button>
            </Group>
          </Stack>
        </form>
      ) : (
        <Markdown text={version.note ?? ""} />
      )}
      <Title order={5}>Links</Title>
      {detail.error && <Notice kind="error">{detail.error}</Notice>}
      {!detail.data ? (
        <Spinner />
      ) : detail.data.links.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nothing linked yet.
        </Text>
      ) : (
        <Table>
          <Table.Tbody>
            {detail.data.links.map((l) => (
              <Table.Tr key={l.id}>
                <Table.Td>
                  <Code>{linkLabel(l)}</Code>
                </Table.Td>
                <Table.Td>{fmtTime(l.createdAt)}</Table.Td>
                <Table.Td>
                  {canWrite && (
                    <Confirm
                      label="Unlink"
                      onConfirm={() => removeLink(l.id)}
                      disabled={act.busy}
                    />
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {canWrite && (
        <form onSubmit={(e) => void addLink(e)}>
          <Group align="end" wrap="wrap">
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
              size="compact-sm"
              disabled={act.busy || !canAdd}
            >
              Add link
            </Button>
          </Group>
        </form>
      )}
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
  const [name, setName] = useState("");
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (
      await act.run(() => api.createVersion(project.id, { name: name.trim() }))
    ) {
      setName("");
      await list.reload();
    }
  };
  const bump = async (part: "patch" | "minor" | "major") => {
    if (await act.run(() => api.bumpVersion(project.id, part)))
      await list.reload();
  };
  const remove = async (v: Version) => {
    if (
      await act.run(async () => {
        await api.deleteVersion(project.id, v.id);
        return true;
      })
    )
      await list.reload();
  };
  const open = (v: Version) =>
    modals.open({
      title: `Version ${v.name}`,
      size: "lg",
      children: (
        <VersionModal
          project={project}
          version={v}
          canWrite={canWrite}
          onChanged={list.reload}
        />
      ),
    });

  return (
    <>
      <Text size="sm" c="dimmed" mb="sm">
        Versions are free strings, unique within the project. <b>Bump</b> takes
        the greatest semver-shaped one (<Code>1.2.3</Code> or{" "}
        <Code>v1.2.3</Code>) and adds one; a version links to the artifacts and
        asset versions that make it up.
      </Text>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {canWrite && (
        <Card withBorder mb="md" padding="sm">
          <form onSubmit={(e) => void create(e)}>
            <Group align="end" wrap="wrap">
              <TextInput
                label="New version"
                placeholder="v1.0.0"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={64}
              />
              <Button type="submit" disabled={act.busy || !name.trim()}>
                Create
              </Button>
              <Group gap="xs">
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
              </Group>
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
                <Table.Th>Version</Table.Th>
                <Table.Th>Note</Table.Th>
                <Table.Th>Artifacts</Table.Th>
                <Table.Th>Assets</Table.Th>
                <Table.Th>By</Table.Th>
                <Table.Th>Created</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.data.map((v) => (
                <Table.Tr key={v.id}>
                  <Table.Td>
                    <Anchor
                      component="button"
                      size="sm"
                      onClick={() => open(v)}
                    >
                      {v.name}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" lineClamp={1}>
                      {v.note ?? "—"}
                    </Text>
                  </Table.Td>
                  <Table.Td>{v.artifactCount}</Table.Td>
                  <Table.Td>{v.assetCount}</Table.Td>
                  <Table.Td>{v.createdBy ?? "—"}</Table.Td>
                  <Table.Td>{fmtTime(v.createdAt)}</Table.Td>
                  <Table.Td>
                    {canWrite && (
                      <Confirm
                        label="Delete"
                        onConfirm={() => remove(v)}
                        disabled={act.busy}
                      />
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <Text size="sm" c="dimmed">
          No versions yet.
        </Text>
      )}
    </>
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
  const [draft, setDraft] = useState<{
    title: string;
    bodyMd: string;
    versionId: string | null;
  } | null>(null);
  const versionName = (id: string | null) =>
    id ? (versions.data?.find((v) => v.id === id)?.name ?? id) : "—";

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const r = await act.run(() =>
      api.createIssue(project.id, {
        title: draft.title.trim(),
        bodyMd: draft.bodyMd,
        versionId: draft.versionId,
      }),
    );
    if (r) void nav(issueUrl(project.teamId, project.id, r.number));
  };

  return (
    <>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <Group justify="space-between" align="end" mb="sm">
        <NativeSelect
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as IssueStatus | "")}
          data={[
            { value: "open", label: "open" },
            { value: "closed", label: "closed" },
            { value: "", label: "all" },
          ]}
        />
        {canWrite && !draft && (
          <Button
            size="compact-sm"
            onClick={() => setDraft({ title: "", bodyMd: "", versionId: null })}
          >
            New issue
          </Button>
        )}
      </Group>
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
              <VersionSelect
                versions={versions.data ?? []}
                value={draft.versionId}
                onChange={(versionId) => setDraft({ ...draft, versionId })}
              />
              <MdField
                label="Description"
                value={draft.bodyMd}
                onChange={(bodyMd) => setDraft({ ...draft, bodyMd })}
              />
              <Group>
                <Button
                  type="submit"
                  disabled={act.busy || !draft.title.trim()}
                >
                  Open issue
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
        <Table.ScrollContainer minWidth={560}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>#</Table.Th>
                <Table.Th>Title</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Version</Table.Th>
                <Table.Th>By</Table.Th>
                <Table.Th>Updated</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.data.map((i) => (
                <Table.Tr key={i.id}>
                  <Table.Td>{i.number}</Table.Td>
                  <Table.Td>
                    <Anchor
                      component={Link}
                      to={issueUrl(project.teamId, project.id, i.number)}
                      size="sm"
                    >
                      {i.title}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>
                    <Badge tone={ISSUE_TONE[i.status]}>{i.status}</Badge>
                  </Table.Td>
                  <Table.Td>{versionName(i.versionId)}</Table.Td>
                  <Table.Td>{i.createdBy ?? "—"}</Table.Td>
                  <Table.Td>{fmtTime(i.updatedAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <Text size="sm" c="dimmed">
          No {status || ""} issues.
        </Text>
      )}
    </>
  );
}

/* ---- settings ------------------------------------------------------------ */

function SettingsTab({
  project,
  canWrite,
  canDelete,
  onChange,
}: {
  project: ProjectDetail;
  canWrite: boolean;
  canDelete: boolean;
  onChange: (p: ProjectDetail) => void;
}) {
  const nav = useNavigate();
  const act = useAction();
  const [name, setName] = useState<string | null>(null);
  const [desc, setDesc] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body: { name?: string; description?: string | null } = {};
    if (name !== null && name.trim() !== project.name) body.name = name.trim();
    if (desc !== null && desc !== (project.description ?? ""))
      body.description = desc === "" ? null : desc;
    if (Object.keys(body).length === 0) return;
    const r = await act.run(() => api.updateProject(project.id, body));
    if (!r) return;
    onChange({ ...project, ...r });
    setName(null);
    setDesc(null);
  };
  const remove = async () => {
    const ok = await act.run(async () => {
      await api.deleteProject(project.id);
      return true;
    });
    if (ok) void nav(teamUrl(project.teamId));
  };

  return (
    <>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <Card withBorder mb="md" padding="sm">
        <CopyField label="Project id" value={project.id} />
        <CopyField label="Team id" value={project.teamId} />
        <Text size="xs" c="dimmed">
          For the CLI: <code>yyt project use {project.id}</code> or{" "}
          <code>{`.yyt.json {"team":"${project.teamId}","project":"${project.id}"}`}</code>
          .
        </Text>
      </Card>
      {canWrite && (
        <Card withBorder mb="md" padding="sm">
          <form onSubmit={(e) => void save(e)}>
            <Stack gap="xs">
              <TextInput
                label="Name"
                value={name ?? project.name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={64}
              />
              <MdField
                label="Description"
                value={desc ?? project.description ?? ""}
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
      {canDelete && (
        <Card withBorder padding="sm">
          <Text size="sm" mb="xs">
            Deleting a project is refused while a channel, app or bundle still
            belongs to it — including channels deleted less than a day ago,
            until the sweep purges them.
          </Text>
          <Confirm
            label="Delete project"
            confirmLabel="Delete"
            onConfirm={remove}
            disabled={act.busy}
          />
        </Card>
      )}
    </>
  );
}
