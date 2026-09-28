import {
  Anchor,
  Button,
  Code,
  Group,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { Clipped } from "../components/Clipped";
import { Crumbs } from "../components/Crumbs";
import { DataTable } from "../components/DataTable";
import { effectiveLimit, LimitsSection, useLimits } from "../components/Limits";
import { PageSkeleton } from "../components/Loading";
import { NameDescriptionFields } from "../components/NameDescriptionFields";
import { PageHeader, type HeaderAction } from "../components/PageHeader";
import { ReadOnlyBanner } from "../components/ReadOnlyBanner";
import { ResourceDrawer, useDrawerForm } from "../components/ResourceDrawer";
import { RowMenu } from "../components/RowMenu";
import { Section } from "../components/Section";
import { Badge, CopyField, CopyText, DropZone, Notice } from "../components/ui";
import { fmtSize } from "../lib/catalog";
import { useCursorList } from "../lib/cursor";
import { fmtTime } from "../lib/format";
import { fmtBytes } from "../lib/limits";
import { notify } from "../lib/notify";
import { useAction, useApiQuery } from "../lib/query";
import { projectUrl, useTeamStanding } from "../lib/team";
import type { AssetFile } from "../types";

/** What the server accepts (`services/console/src/assets.ts`), for the hint. */
const ALLOWED_EXTENSIONS =
  ".json .png .jpg .jpeg .webp .gif .bmp .ogg .mp3 .wav .txt .csv .db .sqlite .bin .zip";

/**
 * Upload a whole bundle version. Each file keeps its path relative to the
 * folder that was dropped, so the relative references inside a map JSON keep
 * resolving once the files are on the CDN.
 */
function PublishSection({
  bundle,
  fileMax,
  onUploaded,
}: {
  bundle: string;
  /** The bundle's effective `asset.fileBytes`, once the limits are loaded. */
  fileMax: number | undefined;
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
      description={`Allowed: ${ALLOWED_EXTENSIONS}${fileMax === undefined ? "" : ` — up to ${fmtBytes(fileMax)} per file`}. A published path is never overwritten. Files over 64 MiB upload with the CLI (yyt asset sync).`}
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

/** One version's files, a page at a time (`GET …/versions/{v}?cursor=`). */
function VersionFiles({
  bundle,
  version,
}: {
  bundle: string;
  version: string;
}) {
  const files = useCursorList(
    ["assets", bundle, version],
    (cursor) => api.assetVersion(bundle, version, { cursor }),
    (page) => page.files,
  );
  return (
    <>
      <DataTable
        columns={[
          { key: "path", label: "Path" },
          { key: "type", label: "Type" },
          { key: "size", label: "Size", align: "right" },
          { key: "url", label: "URL" },
        ]}
        rows={files.rows}
        loading={files.loading}
        error={files.error}
        rowKey={(f) => f.id}
        minWidth={640}
        empty={{ title: "No files in this version." }}
        render={(f) => (
          <>
            <Table.Td>
              <Code>{f.path}</Code>
            </Table.Td>
            <Table.Td>{f.contentType}</Table.Td>
            <Table.Td style={{ textAlign: "right" }}>
              {fmtSize(f.size)}
            </Table.Td>
            <Table.Td>
              <Anchor href={f.url} size="sm" style={{ wordBreak: "break-all" }}>
                {f.url}
              </Anchor>
            </Table.Td>
          </>
        )}
      />
      {files.next && (
        <Button
          variant="default"
          mt="md"
          disabled={files.busy || files.fetching}
          onClick={() => void files.loadMore()}
        >
          Load more
        </Button>
      )}
    </>
  );
}

/**
 * A live bundle's files, a page at a time (`GET …/files?cursor=`). The path
 * opens the file on the CDN; the row menu deletes it.
 */
function LiveFiles({
  bundle,
  canWrite,
  onDeleted,
}: {
  bundle: string;
  canWrite: boolean;
  onDeleted: () => Promise<void>;
}) {
  const files = useCursorList(
    ["assets", bundle, "live"],
    (cursor) => api.assetLiveFiles(bundle, { cursor }),
    (page) => page.files,
  );
  const act = useAction();
  const remove = async (f: AssetFile) => {
    const r = await act.run(async () => {
      const res = await api.deleteAssetFiles(bundle, [f.path]);
      // The row stays when its object could not be deleted.
      if (res.failed.includes(f.path))
        throw new Error(`${f.path} could not be deleted; try again`);
      return res;
    });
    if (!r) return;
    notify.deleted(`file ${f.path}`);
    await Promise.all([files.reload(), onDeleted()]);
  };
  return (
    <>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <DataTable
        columns={[
          // No Type column: the extension in the path names the type, and
          // the table has to fit the 777 px body a 1080 px window leaves.
          { key: "path", label: "Path" },
          { key: "size", label: "Size", align: "right" },
          { key: "sha256", label: "SHA-256" },
          { key: "flags", label: "Flags" },
        ]}
        rows={files.rows}
        loading={files.loading}
        error={files.error}
        rowKey={(f) => f.id}
        minWidth={680}
        empty={{
          title: "No files yet.",
          hint: "yyt asset sync uploads a directory.",
        }}
        render={(f) => (
          <>
            <Table.Td>
              <Clipped
                text={f.path}
                width={240}
                what={`Full path of ${f.path}`}
                prefix={
                  <Anchor
                    href={f.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${f.path}`}
                    style={{ display: "inline-flex", paddingBlock: 4 }}
                  >
                    <IconExternalLink size={16} aria-hidden="true" />
                  </Anchor>
                }
              />
            </Table.Td>
            <Table.Td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
              {fmtSize(f.size)}
            </Table.Td>
            <Table.Td>
              {f.sha256 ? (
                <Clipped
                  text={f.sha256}
                  width={90}
                  what={`SHA-256 of ${f.path}`}
                />
              ) : (
                "—"
              )}
            </Table.Td>
            <Table.Td style={{ whiteSpace: "nowrap" }}>
              {!f.mutable && f.staleSince === null && "—"}
              {f.mutable && <Badge tone="accent">mutable</Badge>}
              {f.mutable && f.staleSince !== null && " "}
              {f.staleSince !== null && <Badge tone="warn">stale</Badge>}
            </Table.Td>
          </>
        )}
        actions={
          canWrite
            ? (f) => (
                <RowMenu
                  name={f.path}
                  items={[
                    {
                      label: "Delete file",
                      danger: true,
                      disabled: act.busy,
                      onClick: () => remove(f),
                      confirm: {
                        title: `Delete ${f.path}?`,
                        message: f.mutable
                          ? "Clients get a 404 for it until a sync uploads it again."
                          : "Edges may keep serving these bytes for a year, so for 400 days this path takes only the same bytes again.",
                        confirmLabel: "Delete file",
                        danger: true,
                      },
                    },
                  ]}
                />
              )
            : undefined
        }
      />
      {files.next && (
        <Button
          variant="default"
          mt="md"
          disabled={files.busy || files.fetching}
          onClick={() => void files.loadMore()}
        >
          Load more
        </Button>
      )}
    </>
  );
}

export function AssetBundlePage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const bundle = useApiQuery(["assets", "bundle", id], () =>
    api.assetBundle(id),
  );
  const standing = useTeamStanding(bundle.data?.teamId);
  const limits = useLimits("bundle", id);
  const act = useAction();
  const [open, setOpen] = useState<string | null>(null);
  /** Files deleted so far by a delete that is still repeating (202s). */
  const [progress, setProgress] = useState<number | null>(null);
  const b = bundle.data;
  const edit = useDrawerForm(() => ({
    name: b?.name ?? "",
    description: b?.description ?? "",
  }));

  const removeVersion = async (version: string) => {
    const ok = await act.run(async () => {
      await api.deleteAssetVersion(id, version, setProgress);
      return true;
    });
    setProgress(null);
    if (!ok) return;
    if (open === version) setOpen(null);
    notify.deleted(`version ${version}`);
    await Promise.all([bundle.reload(), limits.reload()]);
  };

  const removeBundle = async () => {
    const ok = await act.run(async () => {
      await api.deleteAssetBundle(id, setProgress);
      return true;
    });
    setProgress(null);
    if (!ok || !b) return;
    notify.deleted("bundle");
    void navigate(
      b.teamId && b.projectId
        ? projectUrl(b.teamId, b.projectId, "assets")
        : "/teams",
    );
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
  const live = b.mode === "live";
  // A large delete repeats (202s); it can take minutes, so say how far it is,
  // in the drawer when the delete came from its danger zone.
  const deleting = act.busy && progress !== null && (
    <Notice>Deleting… {progress} files so far.</Notice>
  );
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const fileMax = num(effectiveLimit(limits.data, "asset.fileBytes"));
  const bundleMax = num(effectiveLimit(limits.data, "asset.bundleBytes"));
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
        title={b.name}
        badges={<Badge tone={live ? "accent" : "neutral"}>{b.mode}</Badge>}
        description={b.description ?? undefined}
        meta={
          <>
            Created by {b.createdBy ?? "—"} ·{" "}
            {/* Binary units beside a limit, as the limits are defined. */}
            {bundleMax === undefined
              ? fmtSize(b.bytes)
              : `${fmtBytes(b.bytes)} of ${fmtBytes(bundleMax)}`}{" "}
            · {b.files} file{b.files === 1 ? "" : "s"} · id <Code>{b.id}</Code>
          </>
        }
        actions={actions}
      />
      {!canWrite && !standing.loading && <ReadOnlyBanner />}
      {act.error && !edit.opened && <Notice kind="error">{act.error}</Notice>}
      {!edit.opened && deleting}
      {live && canWrite && (
        <Section
          title="Sync"
          description="The console does not upload to a live bundle; yyt asset sync does. It uploads what changed (by SHA-256), then the mutable files, marks files missing from the directory as stale, and with --prune deletes the ones already stale since the previous sync."
        >
          <CopyText
            label="Sync command"
            value={`yyt asset sync ${b.name} <dir> --mutable manifest.json --prune`}
          />
        </Section>
      )}
      {live && (
        <Section
          title="Files"
          description="Immutable files are cached forever and never change; a mutable one is served no-cache. A lobby channel's map must be a file of a versioned bundle: a live file can change under a running game."
        >
          <LiveFiles
            bundle={id}
            canWrite={canWrite}
            onDeleted={async () => {
              await Promise.all([bundle.reload(), limits.reload()]);
            }}
          />
        </Section>
      )}
      {!live && canWrite && (
        <PublishSection
          bundle={id}
          fileMax={fileMax}
          onUploaded={async () => {
            await Promise.all([bundle.reload(), limits.reload()]);
          }}
        />
      )}
      {!live && (
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
                    onClick={() =>
                      setOpen(open === v.version ? null : v.version)
                    }
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
      )}
      {b.teamId !== null && (
        <LimitsSection
          limits={limits}
          standing={standing.standing}
          description="What this bundle may hold. A team member may ask a platform admin for more, up to the ceiling; lowering a limit never deletes a file."
        />
      )}
      {!live && (
        <Section
          title="Publishing a map"
          description={
            <>
              Objects are cached forever and never overwritten. To ship a
              change, upload a new version and paste its entry URL into the
              lobby channel&rsquo;s <b>Map URL</b>: the live pointer is the
              channel config, so nothing has to be invalidated. Versions
              published before 2026-08-26 keep their name-based prefix; the file
              list shows each file&rsquo;s actual URL.
            </>
          }
        >
          <CopyField label="CDN prefix" value={`assets/${b.id}/`} />
        </Section>
      )}
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
        {deleting}
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
