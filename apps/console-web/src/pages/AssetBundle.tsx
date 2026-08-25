import {
  Anchor,
  Button,
  Card,
  Code,
  Group,
  Paper,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useRef, useState, type DragEvent, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { Confirm, CopyField, Notice, Spinner } from "../components/ui";
import { fmtSize } from "../lib/catalog";
import { fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";

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
  const [over, setOver] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    pick(e.dataTransfer.files);
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
      <Paper
        withBorder
        p="md"
        mb="sm"
        role="button"
        tabIndex={0}
        aria-label="Choose or drop the bundle files"
        style={{
          borderStyle: "dashed",
          cursor: "pointer",
          background: over ? "var(--mantine-color-brand-0)" : undefined,
          textAlign: "center",
        }}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) =>
          (e.key === "Enter" || e.key === " ") &&
          (e.preventDefault(), inputRef.current?.click())
        }
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <Text size="sm">
          {files.length
            ? files.map(pathOf).join(", ")
            : "Drop the bundle files here, or click to choose"}
        </Text>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => pick(e.target.files)}
        />
      </Paper>
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
  const { name = "" } = useParams();
  const navigate = useNavigate();
  const bundle = useApiQuery(["assets", "bundle", name], () =>
    api.assetBundle(name),
  );
  const act = useAction();
  const [open, setOpen] = useState<string | null>(null);

  const removeVersion = async (version: string) => {
    const r = await act.run(() => api.deleteAssetVersion(name, version));
    if (r === undefined) return;
    if (open === version) setOpen(null);
    await bundle.reload();
  };

  const removeBundle = async () => {
    const r = await act.run(() => api.deleteAssetBundle(name));
    if (r === undefined) return;
    void navigate("/assets");
  };

  if (bundle.error) return <Notice kind="error">{bundle.error}</Notice>;
  if (!bundle.data) return <Spinner />;
  const b = bundle.data;

  return (
    <>
      <Group justify="space-between" align="start" mb="sm">
        <div>
          <Title order={2}>{b.name}</Title>
          <Text size="sm" c="dimmed">
            {b.description ?? "No description"} · owner {b.ownerLogin ?? "—"} ·{" "}
            {fmtSize(b.bytes)} of 20 MB
          </Text>
        </div>
        <Confirm
          label="Delete bundle"
          confirmLabel="Delete everything"
          onConfirm={() => void removeBundle()}
          disabled={act.busy}
        />
      </Group>
      <Text size="xs" c="dimmed" mb="sm">
        Deleting a version or a bundle is refused while a lobby channel still
        points at it — re-point the channel&rsquo;s map URL first. Clients cache
        these URLs forever, so a deleted version is a game that cannot load.
      </Text>
      {act.error && <Notice kind="error">{act.error}</Notice>}

      <UploadCard bundle={name} onUploaded={() => bundle.reload()} />

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
                <Confirm
                  label="Delete version"
                  confirmLabel="Delete"
                  onConfirm={() => void removeVersion(v.version)}
                  disabled={act.busy}
                />
              </Group>
            </Group>
            {open === v.version && (
              <div style={{ marginTop: 8 }}>
                <VersionFiles bundle={name} version={v.version} />
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
        <CopyField label="CDN prefix" value={`assets/${b.name}/`} />
      </Card>
    </>
  );
}
