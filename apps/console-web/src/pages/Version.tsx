import { Button, Code, NativeSelect, Stack, Table, Text } from "@mantine/core";
import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { Crumbs } from "../components/Crumbs";
import { DataTable, NameCell, NumCell } from "../components/DataTable";
import { EnumFilter, FilterBar, TextFilter } from "../components/FilterBar";
import { PageSkeleton } from "../components/Loading";
import { Markdown } from "../components/Markdown";
import { MdField } from "../components/MdField";
import { PageHeader, type HeaderAction } from "../components/PageHeader";
import { ReadOnlyBanner } from "../components/ReadOnlyBanner";
import { ResourceDrawer, useDrawerForm } from "../components/ResourceDrawer";
import { RowMenu } from "../components/RowMenu";
import { Section } from "../components/Section";
import { Badge, Notice } from "../components/ui";
import { fmtTime } from "../lib/format";
import { noMatch, useListQuery } from "../lib/listQuery";
import { notify } from "../lib/notify";
import { useAction, useApiQuery } from "../lib/query";
import { issueUrl, projectUrl, useTeamStanding } from "../lib/team";
import type {
  IssueStatus,
  VersionLink,
  VersionLinkInput,
  VersionLinkKind,
} from "../types";
import { ISSUE_TONE } from "./Issue";

/** How a link row is named: what it points at, never a bare id when avoidable. */
export function linkLabel(l: VersionLink): string {
  if (l.kind === "artifact") {
    const a = l.artifact;
    return a
      ? [a.appName, a.version, a.abi, a.buildType].filter((x) => x).join(" ")
      : `artifact ${l.artifactId ?? ""}`;
  }
  return `${l.bundleName ?? l.bundleId ?? ""} @ ${l.assetVersion ?? ""}`;
}

/**
 * One project version: its release note, the artifacts and asset versions
 * that make it up, and the issues that reference it. Edit (note + delete)
 * and "Add link" are drawers; the issue list is the server's, filtered by
 * `versionId`.
 */
export function VersionPage() {
  const { team: teamId = "", prj = "", ver = "" } = useParams();
  const nav = useNavigate();
  const t = useTeamStanding(teamId);
  const project = useApiQuery(["project", prj], () => api.project(prj));
  const q = useApiQuery(["version", prj, ver], () => api.version(prj, ver));
  const act = useAction();
  const v = q.data;
  const edit = useDrawerForm(() => ({ note: v?.note ?? "" }));
  const canWrite = t.canWrite;

  const crumbs = (
    <Crumbs
      crumbs={{
        teamId,
        teamName: project.data?.teamName ?? t.team?.name ?? null,
        projectId: prj,
        projectName: project.data?.name ?? null,
      }}
      current={v?.name}
    />
  );

  const saveNote = async (e: FormEvent) => {
    e.preventDefault();
    if (!v) return;
    const note = edit.form.note;
    const r = await act.run(() =>
      api.updateVersion(prj, ver, note.trim() === "" ? null : note),
    );
    if (!r) return;
    q.set({ ...v, ...r });
    edit.close();
    notify.saved("release note");
  };
  const remove = async () => {
    if (
      await act.run(async () => {
        await api.deleteVersion(prj, ver);
        return true;
      })
    ) {
      notify.deleted("version");
      void nav(projectUrl(teamId, prj, "versions"));
    }
  };

  const actions: HeaderAction[] = canWrite
    ? [
        {
          label: "Edit",
          onClick: () => {
            act.clear();
            edit.open();
          },
        },
      ]
    : [];

  return (
    <>
      {crumbs}
      <PageHeader
        title={v?.name}
        meta={
          v && (
            <>
              {v.createdBy ?? "—"} · created {fmtTime(v.createdAt)} ·{" "}
              {v.artifactCount} artifact(s), {v.assetCount} asset version(s)
            </>
          )
        }
        actions={actions}
      />
      {!canWrite && !t.loading && <ReadOnlyBanner />}
      {act.error && !edit.opened && <Notice kind="error">{act.error}</Notice>}
      {v ? (
        <>
          <Section title="Release note">
            {v.note ? (
              <Markdown text={v.note} />
            ) : (
              <Text size="sm" c="dimmed">
                No release note.
              </Text>
            )}
          </Section>
          <LinksSection
            prj={prj}
            ver={ver}
            links={v.links}
            canWrite={canWrite}
            onChanged={q.reload}
          />
          <IssuesSection teamId={teamId} prj={prj} ver={ver} />
          <ResourceDrawer
            opened={edit.opened}
            onClose={edit.close}
            title="Edit version"
            submitLabel="Save"
            onSubmit={saveNote}
            busy={act.busy}
            error={edit.opened ? act.error : null}
            size="lg"
            danger={{
              label: "Delete version",
              description:
                "Its links go with it; issues keep no reference to it.",
              onConfirm: remove,
              disabled: act.busy,
              confirmTitle: `Delete ${v.name}?`,
            }}
          >
            <MdField
              label="Release note"
              value={edit.form.note}
              onChange={(note) => edit.patch({ note })}
              minRows={6}
            />
          </ResourceDrawer>
        </>
      ) : q.error ? (
        <Notice kind="error">{q.error}</Notice>
      ) : (
        <PageSkeleton />
      )}
    </>
  );
}

function LinksSection({
  prj,
  ver,
  links,
  canWrite,
  onChanged,
}: {
  prj: string;
  ver: string;
  links: VersionLink[];
  canWrite: boolean;
  onChanged: () => Promise<void>;
}) {
  const act = useAction();
  const add = useDrawerForm<{
    kind: VersionLinkKind;
    appId: string;
    artifactId: string;
    bundleId: string;
    assetVersion: string;
  }>(() => ({
    kind: "artifact",
    appId: "",
    artifactId: "",
    bundleId: "",
    assetVersion: "",
  }));
  const f = add.form;
  const apps = useApiQuery(
    ["project", prj, "apps"],
    () => api.projectCatalogApps(prj),
    { enabled: add.opened && f.kind === "artifact" },
  );
  const bundles = useApiQuery(
    ["project", prj, "bundles"],
    () => api.projectAssetBundles(prj),
    { enabled: add.opened && f.kind === "asset_version" },
  );
  const artifacts = useApiQuery(
    ["catalog", "app", f.appId, "artifacts"],
    () => api.catalogArtifacts(f.appId),
    { enabled: add.opened && f.kind === "artifact" && f.appId !== "" },
  );
  const bundle = useApiQuery(
    ["assets", "bundle", f.bundleId],
    () => api.assetBundle(f.bundleId),
    { enabled: add.opened && f.kind === "asset_version" && f.bundleId !== "" },
  );
  const body: VersionLinkInput | null =
    f.kind === "artifact"
      ? f.artifactId
        ? { kind: "artifact", artifactId: f.artifactId }
        : null
      : f.bundleId && f.assetVersion
        ? {
            kind: "asset_version",
            bundleId: f.bundleId,
            assetVersion: f.assetVersion,
          }
        : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!body) return;
    if (await act.run(() => api.addVersionLink(prj, ver, body))) {
      add.close();
      notify.done("Link added");
      await onChanged();
    }
  };
  const unlink = async (l: VersionLink) => {
    if (
      await act.run(async () => {
        await api.removeVersionLink(prj, ver, l.id);
        return true;
      })
    ) {
      notify.done("Link removed");
      await onChanged();
    }
  };

  return (
    <Section
      title="Links"
      description="The catalog artifacts and asset versions that make up this version. A catalog deploy links its artifact here by itself."
      actions={
        canWrite && (
          <Button
            variant="default"
            onClick={() => {
              act.clear();
              add.open();
            }}
          >
            Add link
          </Button>
        )
      }
    >
      {act.error && !add.opened && <Notice kind="error">{act.error}</Notice>}
      <DataTable
        columns={[
          { key: "target", label: "Target" },
          { key: "kind", label: "Kind" },
          { key: "created", label: "Linked" },
        ]}
        rows={links}
        rowKey={(l) => l.id}
        minWidth={480}
        empty={{ title: "Nothing linked yet." }}
        render={(l) => (
          <>
            {l.kind === "artifact" ? (
              l.artifact ? (
                <NameCell
                  to={`/catalog/apps/${encodeURIComponent(l.artifact.appId)}`}
                  after={<Badge tone="neutral">{l.artifact.platform}</Badge>}
                >
                  {linkLabel(l)}
                </NameCell>
              ) : (
                <Table.Td>
                  <Code>{linkLabel(l)}</Code>
                </Table.Td>
              )
            ) : (
              <NameCell to={`/assets/${encodeURIComponent(l.bundleId ?? "")}`}>
                {linkLabel(l)}
              </NameCell>
            )}
            <Table.Td>
              {l.kind === "artifact" ? "catalog artifact" : "asset version"}
            </Table.Td>
            <Table.Td>{fmtTime(l.createdAt)}</Table.Td>
          </>
        )}
        actions={
          canWrite
            ? (l) => (
                <RowMenu
                  name={linkLabel(l)}
                  items={[
                    {
                      label: "Unlink",
                      danger: true,
                      disabled: act.busy,
                      onClick: () => unlink(l),
                      confirm: {
                        title: "Unlink?",
                        message: linkLabel(l),
                        confirmLabel: "Unlink",
                        danger: true,
                      },
                    },
                  ]}
                />
              )
            : undefined
        }
      />
      <ResourceDrawer
        opened={add.opened}
        onClose={add.close}
        title="Add link"
        submitLabel="Add link"
        onSubmit={submit}
        busy={act.busy}
        disabled={!body}
        error={add.opened ? act.error : null}
      >
        <Stack gap="sm">
          <NativeSelect
            label="Link"
            value={f.kind}
            onChange={(e) =>
              add.patch({
                kind: e.target.value as VersionLinkKind,
                artifactId: "",
                assetVersion: "",
              })
            }
            data={[
              { value: "artifact", label: "catalog artifact" },
              { value: "asset_version", label: "asset version" },
            ]}
          />
          {f.kind === "artifact" ? (
            <>
              <NativeSelect
                label="App"
                value={f.appId}
                onChange={(e) =>
                  add.patch({ appId: e.target.value, artifactId: "" })
                }
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
                value={f.artifactId}
                onChange={(e) => add.patch({ artifactId: e.target.value })}
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
                value={f.bundleId}
                onChange={(e) =>
                  add.patch({ bundleId: e.target.value, assetVersion: "" })
                }
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
                value={f.assetVersion}
                onChange={(e) => add.patch({ assetVersion: e.target.value })}
                data={[
                  { value: "", label: "— choose —" },
                  ...(bundle.data?.versions ?? []).map((x) => ({
                    value: x.version,
                    label: x.version,
                  })),
                ]}
              />
            </>
          )}
        </Stack>
      </ResourceDrawer>
    </Section>
  );
}

function IssuesSection({
  teamId,
  prj,
  ver,
}: {
  teamId: string;
  prj: string;
  ver: string;
}) {
  const [status, setStatus] = useState<IssueStatus | "">("");
  const lq = useListQuery({ scope: ver });
  const list = useApiQuery(
    ["issues", prj, "version", ver, status, lq.params],
    () =>
      api.issues(prj, status || undefined, { ...lq.params, versionId: ver }),
    { keepPrevious: true },
  );
  return (
    <Section title="Issues" description="Issues that reference this version.">
      <FilterBar>
        <EnumFilter
          label="Status"
          value={status}
          options={[
            { value: "open", label: "Open" },
            { value: "closed", label: "Closed" },
            { value: "", label: "All" },
          ]}
          onChange={(x) => setStatus(x as IssueStatus | "")}
        />
        <TextFilter value={lq.q} onChange={lq.setQ} placeholder="Title" />
      </FilterBar>
      <DataTable
        columns={[
          {
            key: "n",
            label: "#",
            align: "right",
            sortKey: "number",
            defaultOrder: "desc",
          },
          { key: "title", label: "Title", sortKey: "title" },
          { key: "status", label: "Status", sortKey: "status" },
          { key: "by", label: "By", sortKey: "createdBy" },
          {
            key: "updated",
            label: "Updated",
            sortKey: "updatedAt",
            defaultOrder: "desc",
          },
        ]}
        rows={list.data}
        loading={list.loading}
        fetching={list.fetching}
        error={list.error}
        sort={lq.sort}
        onSort={lq.setSort}
        rowKey={(i) => i.id}
        empty={
          lq.filtering
            ? noMatch(lq.params.q ?? "")
            : { title: "No issue references this version." }
        }
        render={(i) => (
          <>
            <NumCell>{i.number}</NumCell>
            <NameCell to={issueUrl(teamId, prj, i.number)}>{i.title}</NameCell>
            <Table.Td>
              <Badge tone={ISSUE_TONE[i.status]}>{i.status}</Badge>
            </Table.Td>
            <Table.Td>{i.createdBy ?? "—"}</Table.Td>
            <Table.Td>{fmtTime(i.updatedAt)}</Table.Td>
          </>
        )}
      />
    </Section>
  );
}
