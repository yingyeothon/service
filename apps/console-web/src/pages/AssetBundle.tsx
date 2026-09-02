import {
  Anchor,
  Button,
  Code,
  Group,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { Crumbs } from "../components/Crumbs";
import { DataTable } from "../components/DataTable";
import { Loading, PageSkeleton } from "../components/Loading";
import { NameDescriptionFields } from "../components/NameDescriptionFields";
import { PageHeader, type HeaderAction } from "../components/PageHeader";
import { ReadOnlyBanner } from "../components/ReadOnlyBanner";
import { ResourceDrawer, useDrawerForm } from "../components/ResourceDrawer";
import { RowMenu } from "../components/RowMenu";
import { Section } from "../components/Section";
import { CopyField, DropZone, Notice } from "../components/ui";
import { fmtSize } from "../lib/catalog";
import { useConfirm } from "../lib/confirm";
import { fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { useAction, useApiQuery } from "../lib/query";
import { projectUrl, useTeamStanding } from "../lib/team";

/**
 * Upload a whole bundle version. Each file keeps its path relative to the
 * folder that was dropped, so the relative references inside a map JSON keep
 * resolving once the files are on the CDN.
 */
function PublishSection({
  bundle,
  onUploaded,
}: {
  bundle: string;
  onUploaded: () => Promise<void>;
}) {
  const act = useAction();
  const [version, setVersion] = useState("");
  const [files, setFiles] = useState<File[]>([]);

  /**
   * `webkitRelativePath` is set when a directory was picked; it starts with the
   * directory's own name, which must not become a bundle path segment.
   */
  const pathOf = (f: File) => {
    const rel = (f as File & { webkitRelativePath?: string })
      .webkitRelativePath;
    if (!rel) return f.name;
    const cut = rel.indexOf("/");
    return cut < 0 ? rel : rel.slice(cut + 1);
  };

  const pick = (list: FileList | null) => setFiles(list ? [...list] : []);

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (files.length === 0) return;
    const v = version.trim();
    // A version is published one file at a time, so a failure halfway leaves a
    // partial version. Keep only what did not land: retrying the whole set
    // would 409 on the files that did (a published path is write-once).
    const left = [...files];
    const r = await act.run(async () => {
      while (left.length > 0) {
        await api.uploadAssetFile(bundle, v, pathOf(left[0]!), left[0]!);
        left.shift();
      }
      return files.length;
    });
    setFiles(left);
    // Reload either way: on a partial failure the versions list has changed.
    await onUploaded();
    if (!r) return;
    setVersion("");
    notify.done(`${r} file(s) published as ${v}`);
  };

  return (
    <Section
      title="Publish a version"
      description="Allowed: .json .png .jpg .jpeg .webp .gif .bmp .ogg .mp3 .wav .txt .csv — up to 2 MB per file. A published path is never overwritten."
    >
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <form onSubmit={(e) => void upload(e)}>
        <DropZone
          label="Choose or drop the bundle files"
          multiple
          onFiles={pick}
        >
          {files.length
            ? files.map(pathOf).join(", ")
            : "Drop the bundle files here, or click to choose"}
        </DropZone>
        <Group align="end" wrap="wrap">
          <TextInput
            label="Version"
            placeholder="v1"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            required
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
          />
          <Button
            type="submit"
            variant="default"
            disabled={act.busy || !version.trim() || files.length === 0}
            loading={act.busy}
          >
            Upload {files.length || ""}
          </Button>
        </Group>
      </form>
    </Section>
  );
}

function VersionFiles({
  bundle,
  version,
}: {
  bundle: string;
  version: string;
}) {
  const files = useApiQuery(["assets", bundle, version], () =>
    api.assetVersion(bundle, version),
  );
  if (files.error) return <Notice kind="error">{files.error}</Notice>;
  if (!files.data) return <Loading />;
  return (
    <DataTable
      columns={[
        { key: "path", label: "Path" },
        { key: "type", label: "Type" },
        { key: "size", label: "Size", align: "right" },
        { key: "url", label: "URL" },
      ]}
      rows={files.data.files}
      rowKey={(f) => f.id}
      minWidth={640}
      empty={{ title: "No files in this version." }}
      render={(f) => (
        <>
          <Table.Td>
            <Code>{f.path}</Code>
          </Table.Td>
          <Table.Td>{f.contentType}</Table.Td>
          <Table.Td style={{ textAlign: "right" }}>{fmtSize(f.size)}</Table.Td>
          <Table.Td>
            <Anchor href={f.url} size="sm" style={{ wordBreak: "break-all" }}>
              {f.url}
            </Anchor>
          </Table.Td>
        </>
      )}
    />
  );
}

export function AssetBundlePage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const bundle = useApiQuery(["assets", "bundle", id], () =>
    api.assetBundle(id),
  );
  const standing = useTeamStanding(bundle.data?.teamId);
  const act = useAction();
  const confirm = useConfirm();
  const [open, setOpen] = useState<string | null>(null);
  const b = bundle.data;
  const edit = useDrawerForm(() => ({
    name: b?.name ?? "",
    description: b?.description ?? "",
  }));

  const removeVersion = async (version: string) => {
    const ok = await act.run(async () => {
      await api.deleteAssetVersion(id, version);
      return true;
    });
    if (!ok) return;
    if (open === version) setOpen(null);
    notify.deleted(`version ${version}`);
    await bundle.reload();
  };

  const removeBundle = async () => {
    const ok = await act.run(async () => {
      await api.deleteAssetBundle(id);
      return true;
    });
    if (!ok || !b) return;
    notify.deleted("bundle");
    void navigate(
      b.teamId && b.projectId
        ? projectUrl(b.teamId, b.projectId, "assets")
        : "/teams",
    );
  };
  const removeFromMenu = async () => {
    const r = await confirm({
      title: `Delete ${b?.name ?? "bundle"}?`,
      message: "Every version and file goes with it.",
      confirmLabel: "Delete bundle",
      danger: true,
    });
    if (r.ok) await removeBundle();
  };

  const saveInfo = async (e: FormEvent) => {
    e.preventDefault();
    if (!b) return;
    const body: { name?: string; description?: string | null } = {};
    const name = edit.form.name.trim();
    if (name !== b.name) body.name = name;
    const desc = edit.form.description.trim();
    if (desc !== (b.description ?? "")) body.description = desc || null;
    if (Object.keys(body).length === 0) {
      edit.close();
      return;
    }
    const r = await act.run(() => api.updateAssetBundle(id, body));
    if (!r) return;
    bundle.set({ ...b, ...r });
    edit.close();
    notify.saved("bundle");
  };

  const crumbs = <Crumbs crumbs={b ?? {}} current={b?.name} />;
  if (bundle.error)
    return (
      <>
        {crumbs}
        <PageHeader />
        <Notice kind="error">{bundle.error}</Notice>
      </>
    );
  if (!b)
    return (
      <>
        {crumbs}
        <PageHeader />
        <PageSkeleton />
      </>
    );
  const canWrite = standing.canWrite;
  const actions: HeaderAction[] = canWrite
    ? [
        { label: "Edit", onClick: edit.open },
        {
          label: "Delete bundle",
          danger: true,
          onClick: removeFromMenu,
          disabled: act.busy,
        },
      ]
    : [];

  return (
    <>
      {crumbs}
      <PageHeader
        title={b.name}
        description={b.description ?? undefined}
        meta={
          <>
            Created by {b.createdBy ?? "—"} · {fmtSize(b.bytes)} of 20 MB · id{" "}
            <Code>{b.id}</Code>
          </>
        }
        actions={actions}
      />
      {!canWrite && !standing.loading && <ReadOnlyBanner />}
      {act.error && !edit.opened && <Notice kind="error">{act.error}</Notice>}
      {canWrite && (
        <PublishSection bundle={id} onUploaded={() => bundle.reload()} />
      )}
      <Section
        title="Versions"
        description="Deleting a version or a bundle is refused while a lobby channel still points at it — re-point the channel’s map URL first. Clients cache these URLs forever, so a deleted version is a game that cannot load."
      >
        <DataTable
          columns={[
            { key: "version", label: "Version" },
            { key: "files", label: "Files", align: "right" },
            { key: "size", label: "Size", align: "right" },
            { key: "created", label: "Created" },
            { key: "show", label: "" },
          ]}
          rows={b.versions}
          rowKey={(v) => v.version}
          minWidth={560}
          empty={{ title: "No versions published yet." }}
          render={(v) => (
            <>
              <Table.Td>
                <Text size="sm" fw={500}>
                  {v.version}
                </Text>
              </Table.Td>
              <Table.Td style={{ textAlign: "right" }}>{v.files}</Table.Td>
              <Table.Td style={{ textAlign: "right" }}>
                {fmtSize(v.bytes)}
              </Table.Td>
              <Table.Td>{fmtTime(v.createdAt)}</Table.Td>
              <Table.Td>
                <Button
                  size="compact-sm"
                  variant="subtle"
                  color="ink"
                  onClick={() => setOpen(open === v.version ? null : v.version)}
                  aria-expanded={open === v.version}
                >
                  {open === v.version ? "Hide files" : "Show files"}
                </Button>
              </Table.Td>
            </>
          )}
          actions={
            canWrite
              ? (v) => (
                  <RowMenu
                    name={v.version}
                    items={[
                      {
                        label: "Delete version",
                        danger: true,
                        disabled: act.busy,
                        onClick: () => removeVersion(v.version),
                        confirm: {
                          title: `Delete ${v.version}?`,
                          message:
                            "Refused while a lobby channel still points at it.",
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
        {open && (
          <div style={{ marginTop: 16 }}>
            <Text size="sm" fw={500} mb="xs">
              Files of {open}
            </Text>
            <VersionFiles bundle={id} version={open} />
          </div>
        )}
      </Section>
      <Section
        title="Publishing a map"
        description={
          <>
            Objects are cached forever and never overwritten. To ship a change,
            upload a new version and paste its entry URL into the lobby
            channel&rsquo;s <b>Map URL</b>: the live pointer is the channel
            config, so nothing has to be invalidated. Versions published before
            2026-08-26 keep their name-based prefix; the file list shows each
            file&rsquo;s actual URL.
          </>
        }
      >
        <CopyField label="CDN prefix" value={`assets/${b.id}/`} />
      </Section>
      <ResourceDrawer
        opened={edit.opened}
        onClose={edit.close}
        title="Edit bundle"
        submitLabel="Save"
        onSubmit={saveInfo}
        busy={act.busy}
        disabled={!edit.form.name.trim()}
        error={edit.opened ? act.error : null}
        danger={{
          label: "Delete bundle",
          description: "Every version and file goes with it.",
          onConfirm: removeBundle,
          disabled: act.busy,
        }}
      >
        <NameDescriptionFields
          name={edit.form.name}
          description={edit.form.description}
          onName={(name) => edit.patch({ name })}
          onDescription={(description) => edit.patch({ description })}
        />
      </ResourceDrawer>
    </>
  );
}
