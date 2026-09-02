import {
  Anchor,
  Button,
  Card,
  Code,
  Group,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { Crumbs } from "../components/Crumbs";
import {
  Confirm,
  CopyField,
  DropZone,
  Notice,
  Spinner,
} from "../components/ui";
import { ResourceInfoForm } from "../components/ResourceForms";
import { fmtSize } from "../lib/catalog";
import { fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";
import { projectUrl, useTeamStanding } from "../lib/team";

/**
 * Upload a whole bundle version. Each file keeps its path relative to the
 * folder that was dropped, so the relative references inside a map JSON keep
 * resolving once the files are on the CDN.
 */
function UploadCard({
  bundle,
  onUploaded,
}: {
  bundle: string;
  onUploaded: () => Promise<void>;
}) {
  const act = useAction();
  const [version, setVersion] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [done, setDone] = useState<string | null>(null);

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

  const pick = (list: FileList | null) => {
    setDone(null);
    setFiles(list ? [...list] : []);
  };

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
    setDone(`${r} file(s) published as ${v}`);
  };

  return (
    <Card withBorder mb="md" padding="sm">
      <Text size="sm" fw={600} mb={4}>
        Publish a version
      </Text>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {done && <Notice kind="success">{done}</Notice>}
      <DropZone label="Choose or drop the bundle files" multiple onFiles={pick}>
        {files.length
          ? files.map(pathOf).join(", ")
          : "Drop the bundle files here, or click to choose"}
      </DropZone>
      <form onSubmit={(e) => void upload(e)}>
        <Group align="end" wrap="wrap">
          <TextInput
            label="Version"
            placeholder="v1"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            required
            maxLength={64}
          />
          <Button
            type="submit"
            disabled={act.busy || !version.trim() || files.length === 0}
          >
            Upload {files.length || ""}
          </Button>
        </Group>
      </form>
      <Text size="xs" c="dimmed" mt={6}>
        Allowed: .json .png .jpg .jpeg .webp .gif .bmp .ogg .mp3 .wav .txt .csv
        — up to 2 MB per file. A published path is never overwritten.
      </Text>
    </Card>
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
  if (!files.data) return <Spinner />;
  return (
    <Table.ScrollContainer minWidth={640}>
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Path</Table.Th>
            <Table.Th>Type</Table.Th>
            <Table.Th>Size</Table.Th>
            <Table.Th>URL</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {files.data.files.map((f) => (
            <Table.Tr key={f.id}>
              <Table.Td>
                <Code>{f.path}</Code>
              </Table.Td>
              <Table.Td>{f.contentType}</Table.Td>
              <Table.Td>{fmtSize(f.size)}</Table.Td>
              <Table.Td>
                <Anchor
                  href={f.url}
                  size="sm"
                  style={{ wordBreak: "break-all" }}
                >
                  {f.url}
                </Anchor>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
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
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [desc, setDesc] = useState<string | null>(null);

  const removeVersion = async (version: string) => {
    const ok = await act.run(async () => {
      await api.deleteAssetVersion(id, version);
      return true;
    });
    if (!ok) return;
    if (open === version) setOpen(null);
    await bundle.reload();
  };

  const removeBundle = async () => {
    const ok = await act.run(async () => {
      await api.deleteAssetBundle(id);
      return true;
    });
    if (!ok || !bundle.data) return;
    const b = bundle.data;
    void navigate(
      b.teamId && b.projectId
        ? projectUrl(b.teamId, b.projectId, "assets")
        : "/teams",
    );
  };

  const saveInfo = async (e: FormEvent) => {
    e.preventDefault();
    if (!bundle.data) return;
    const b = bundle.data;
    const body: { name?: string; description?: string | null } = {};
    if (name !== null && name.trim() !== b.name) body.name = name.trim();
    if (desc !== null) body.description = desc.trim() || null;
    if (Object.keys(body).length === 0) return;
    const r = await act.run(() => api.updateAssetBundle(id, body));
    if (!r) return;
    bundle.set({ ...b, ...r });
    setName(null);
    setDesc(null);
  };

  if (bundle.error) return <Notice kind="error">{bundle.error}</Notice>;
  if (!bundle.data) return <Spinner />;
  const b = bundle.data;
  const canWrite = standing.canWrite;

  return (
    <>
      <Crumbs crumbs={b} current={b.name} />
      <Group justify="space-between" align="start" mb="sm">
        <div>
          <Title order={2}>{b.name}</Title>
          <Text size="sm" c="dimmed">
            {b.description ?? "No description"} · created by{" "}
            {b.createdBy ?? "—"} · {fmtSize(b.bytes)} of 20 MB
          </Text>
        </div>
        {canWrite && (
          <Confirm
            label="Delete bundle"
            confirmLabel="Delete everything"
            onConfirm={() => void removeBundle()}
            disabled={act.busy}
          />
        )}
      </Group>
      {!canWrite && !standing.loading && (
        <Notice>
          Read-only: you are not seated in this bundle&rsquo;s team.
        </Notice>
      )}
      {canWrite && (
        <ResourceInfoForm
          name={name ?? b.name}
          description={desc ?? b.description ?? ""}
          onName={setName}
          onDescription={setDesc}
          onSubmit={saveInfo}
          busy={act.busy}
        />
      )}
      <Text size="xs" c="dimmed" mb="sm">
        Deleting a version or a bundle is refused while a lobby channel still
        points at it — re-point the channel&rsquo;s map URL first. Clients cache
        these URLs forever, so a deleted version is a game that cannot load.
      </Text>
      {act.error && <Notice kind="error">{act.error}</Notice>}

      {canWrite && (
        <UploadCard bundle={id} onUploaded={() => bundle.reload()} />
      )}

      {b.versions.length === 0 ? (
        <Text size="sm" c="dimmed">
          No versions published yet.
        </Text>
      ) : (
        b.versions.map((v) => (
          <Card withBorder mb="sm" padding="sm" key={v.version}>
            <Group justify="space-between" wrap="wrap">
              <Group gap="sm">
                <Text fw={600}>{v.version}</Text>
                <Text size="sm" c="dimmed">
                  {v.files} file(s) · {fmtSize(v.bytes)} ·{" "}
                  {fmtTime(v.createdAt)}
                </Text>
              </Group>
              <Group gap="xs">
                <Button
                  size="compact-sm"
                  variant="default"
                  onClick={() => setOpen(open === v.version ? null : v.version)}
                >
                  {open === v.version ? "Hide files" : "Show files"}
                </Button>
                {canWrite && (
                  <Confirm
                    label="Delete version"
                    confirmLabel="Delete"
                    onConfirm={() => void removeVersion(v.version)}
                    disabled={act.busy}
                  />
                )}
              </Group>
            </Group>
            {open === v.version && (
              <div style={{ marginTop: 8 }}>
                <VersionFiles bundle={id} version={v.version} />
              </div>
            )}
          </Card>
        ))
      )}

      <Card withBorder mt="md" padding="sm">
        <Text size="sm" fw={600} mb={4}>
          Publishing a map
        </Text>
        <Text size="sm" c="dimmed" mb="xs">
          Objects are cached forever and never overwritten. To ship a change,
          upload a new version and paste its entry URL into the lobby
          channel&rsquo;s <b>Map URL</b>: the live pointer is the channel
          config, so nothing has to be invalidated.
        </Text>
        <CopyField label="CDN prefix" value={`assets/${b.id}/`} />
        <Text size="xs" c="dimmed">
          Versions published before 2026-08-26 keep their name-based prefix; the
          file list shows each file&rsquo;s actual URL.
        </Text>
      </Card>
    </>
  );
}
