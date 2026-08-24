import {
  Anchor,
  Button,
  Card,
  Checkbox,
  Code,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useRef, useState, type DragEvent, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api, ApiError } from "../api";
import { CatalogPermissionsCard } from "../components/CatalogPermissions";
import { Badge, Confirm, Notice, Spinner } from "../components/ui";
import {
  fmtSize,
  groupArtifactsByVersion,
  isIosUserAgent,
} from "../lib/catalog";
import { fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";
import {
  CATALOG_PLATFORMS,
  type CatalogApp,
  type CatalogCleanupResult,
  type CatalogPlatform,
} from "../types";

/** Best-effort platform guess from the chosen file. */
function guessPlatform(filename: string): CatalogPlatform | null {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (ext === ".apk" || ext === ".aab") return "android";
  if (ext === ".ipa") return "ios";
  return null;
}

function UploadCard({
  app,
  onUploaded,
}: {
  app: CatalogApp;
  onUploaded: () => Promise<void>;
}) {
  const act = useAction();
  const [file, setFile] = useState<File | null>(null);
  const [platform, setPlatform] = useState<CatalogPlatform>("android");
  const [version, setVersion] = useState("");
  const [buildType, setBuildType] = useState<string | null>(null);
  const [distribution, setDistribution] = useState<string | null>(null);
  const [bundleId, setBundleId] = useState("");
  const [buildNumber, setBuildNumber] = useState("");
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = (f: File | null) => {
    setFile(f);
    if (f) {
      const guessed = guessPlatform(f.name);
      if (guessed) setPlatform(guessed);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    pick(e.dataTransfer.files[0] ?? null);
  };

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    const tags: Record<string, string> = { version: version.trim() };
    if (platform === "android" && buildType) tags.build_type = buildType;
    if (platform === "ios" && distribution) {
      tags.distribution_method = distribution;
      if (distribution === "ad-hoc") {
        tags.bundle_id = bundleId.trim();
        tags.build_number = buildNumber.trim();
      }
    }
    const r = await act.run(() =>
      api.uploadCatalogArtifact(app.name, file, platform, tags),
    );
    if (!r) return;
    setFile(null);
    setVersion("");
    await onUploaded();
  };

  return (
    <Card withBorder mb="md" padding="sm">
      <Text size="sm" fw={600} mb={4}>
        Upload artifact
      </Text>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <Paper
        withBorder
        p="md"
        mb="sm"
        role="button"
        tabIndex={0}
        aria-label="Choose or drop a file"
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
        <Text size="sm" c={file ? undefined : "dimmed"}>
          {file
            ? `${file.name} (${fmtSize(file.size)})`
            : "Drag & drop a file here, or click to choose"}
        </Text>
        <input
          ref={inputRef}
          type="file"
          hidden
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
      </Paper>
      <form onSubmit={(e) => void upload(e)}>
        <Group align="end" wrap="wrap">
          <Select
            label="Platform"
            data={[...CATALOG_PLATFORMS]}
            value={platform}
            onChange={(v) => setPlatform((v as CatalogPlatform) ?? "android")}
            allowDeselect={false}
            w={120}
          />
          <TextInput
            label="Version"
            placeholder="1.2.3"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            required
            w={140}
          />
          {platform === "android" && (
            <Select
              label="Build type"
              placeholder="(none)"
              clearable
              data={["debug", "release", "appbundle"]}
              value={buildType}
              onChange={setBuildType}
              w={140}
            />
          )}
          {platform === "ios" && (
            <Select
              label="Distribution"
              placeholder="(none)"
              clearable
              data={["ad-hoc", "app-store", "development"]}
              value={distribution}
              onChange={setDistribution}
              w={140}
            />
          )}
          {platform === "ios" && distribution === "ad-hoc" && (
            <>
              <TextInput
                label="Bundle id"
                placeholder="life.yyt.app"
                value={bundleId}
                onChange={(e) => setBundleId(e.target.value)}
                required
                w={180}
              />
              <TextInput
                label="Build number"
                placeholder="42"
                value={buildNumber}
                onChange={(e) => setBuildNumber(e.target.value)}
                required
                w={110}
              />
            </>
          )}
          <Button
            type="submit"
            disabled={act.busy || !file || !version.trim()}
            loading={act.busy}
          >
            Upload
          </Button>
        </Group>
      </form>
    </Card>
  );
}

function SettingsCard({ app }: { app: CatalogApp }) {
  // Owner/admin only: a 403 hides the card entirely.
  const settings = useApiQuery(
    ["catalog", "app", app.name, "settings"],
    async () => {
      try {
        return await api.catalogSettings(app.name);
      } catch (e) {
        // `null` = not owner/admin: the card stays hidden. TanStack Query v5
        // rejects `undefined` from a queryFn.
        if (e instanceof ApiError && (e.status === 403 || e.status === 404))
          return null;
        throw e;
      }
    },
  );
  const act = useAction();
  const [hook, setHook] = useState<string | null>(null);
  const [channel, setChannel] = useState<string | null>(null);
  const [template, setTemplate] = useState<string | null>(null);
  // Raw NumberInput state: clearing emits "" and must not snap back.
  const [keep, setKeep] = useState<number | string | null>(null);
  const s = settings.data;
  if (settings.error) return <Notice kind="error">{settings.error}</Notice>;
  if (s === undefined || s === null) return null; // loading or not owner

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if (hook !== null) body.slackHookUrl = hook.trim() || null;
    if (channel !== null) body.slackChannel = channel.trim() || null;
    if (template !== null) body.messageTemplate = template.trim() || null;
    if (typeof keep === "number") body.keepRecentVersions = keep;
    if (Object.keys(body).length === 0) return;
    const r = await act.run(() => api.updateCatalogSettings(app.name, body));
    if (!r) return;
    settings.set(r);
    setHook(null);
    setChannel(null);
    setTemplate(null);
    setKeep(null);
  };

  return (
    <Card withBorder mb="md" padding="sm">
      <Text size="sm" fw={600} mb={4}>
        Settings (owner only)
      </Text>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <form onSubmit={(e) => void save(e)}>
        <Stack gap="xs">
          <TextInput
            label="Slack webhook URL"
            placeholder="https://hooks.slack.com/services/…"
            value={hook ?? s.slackHookUrl ?? ""}
            onChange={(e) => setHook(e.target.value)}
          />
          <Group grow>
            <TextInput
              label="Slack channel"
              placeholder="#releases"
              value={channel ?? s.slackChannel ?? ""}
              onChange={(e) => setChannel(e.target.value)}
            />
            <NumberInput
              label="Keep recent versions"
              min={1}
              max={100}
              value={keep ?? s.keepRecentVersions}
              onChange={setKeep}
            />
          </Group>
          <TextInput
            label="Message template"
            placeholder="{{app}} {{version}} ({{stage}}) uploaded"
            value={template ?? s.messageTemplate ?? ""}
            onChange={(e) => setTemplate(e.target.value)}
          />
          <Group>
            <Button type="submit" disabled={act.busy}>
              Save settings
            </Button>
          </Group>
        </Stack>
      </form>
    </Card>
  );
}

function CleanupCard({
  app,
  onDone,
}: {
  app: CatalogApp;
  onDone: () => Promise<void>;
}) {
  const act = useAction();
  const [result, setResult] = useState<CatalogCleanupResult | null>(null);
  const run = async (dryRun: boolean) => {
    const r = await act.run(() =>
      api.cleanupCatalogArtifacts(app.name, dryRun),
    );
    if (!r) return;
    setResult(r);
    if (!dryRun) await onDone();
  };
  return (
    <Card withBorder mb="md" padding="sm">
      <Text size="sm" fw={600} mb={4}>
        Retention cleanup (owner only)
      </Text>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <Group mb="xs">
        <Button
          size="compact-sm"
          variant="default"
          onClick={() => void run(true)}
          disabled={act.busy}
        >
          Preview (dry run)
        </Button>
        <Confirm
          label="Run cleanup"
          onConfirm={() => run(false)}
          disabled={act.busy}
        />
      </Group>
      {result && (
        <Text size="sm" c="dimmed">
          {result.executed
            ? `Deleted ${result.deleted} artifact(s)` +
              (result.s3Failures ? `, ${result.s3Failures} S3 failure(s)` : "")
            : `Would delete ${result.preview.deletions.length} of ${result.preview.totalArtifacts} artifact(s) (keep ${result.preview.keepRecentVersions} versions): ` +
              result.preview.deletions
                .map((d) => `${d.version}/${d.platform} (${d.reason})`)
                .join(", ")}
        </Text>
      )}
    </Card>
  );
}

export function CatalogAppPage() {
  const { name = "" } = useParams();
  const navigate = useNavigate();
  const app = useApiQuery(["catalog", "app", name], () => api.catalogApp(name));
  const artifacts = useApiQuery(["catalog", "app", name, "artifacts"], () =>
    api.catalogArtifacts(name),
  );
  const groups = useApiQuery(["catalog", "groups"], () => api.catalogGroups());
  // `null` = not owner/admin (card hidden); TanStack Query v5 rejects
  // `undefined` from a queryFn.
  const perms = useApiQuery(["catalog", "app", name, "perms"], async () => {
    try {
      return await api.catalogAppPermissions(name);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404))
        return null;
      throw e;
    }
  });
  const act = useAction();
  const [desc, setDesc] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null | undefined>(undefined);
  const [debugOnly, setDebugOnly] = useState<boolean | null>(null);
  const iosDevice = isIosUserAgent(navigator.userAgent);

  if (app.error) return <Notice kind="error">{app.error}</Notice>;
  if (!app.data) return <Spinner />;
  const a = app.data;

  const saveInfo = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if (desc !== null) body.description = desc.trim() || null;
    if (groupId !== undefined) body.groupId = groupId;
    if (debugOnly !== null) body.debugOnly = debugOnly;
    if (Object.keys(body).length === 0) return;
    const r = await act.run(() => api.updateCatalogApp(a.name, body));
    if (!r) return;
    app.set(r);
    setDesc(null);
    setGroupId(undefined);
    setDebugOnly(null);
  };

  const versionGroups = groupArtifactsByVersion(artifacts.data ?? []);

  return (
    <>
      <Title order={2} mb="sm">
        {a.name} {a.debugOnly && <Badge tone="warn">debug</Badge>}
      </Title>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <Card withBorder mb="md" padding="sm">
        <Text size="sm" mb={4}>
          <Code>{a.path}</Code> · owner{" "}
          {a.ownerLogin ?? a.pendingOwnerLogin ?? "—"} · created{" "}
          {fmtTime(a.createdAt)}
        </Text>
        <form onSubmit={(e) => void saveInfo(e)}>
          <Group align="end" wrap="wrap">
            <TextInput
              label="Description"
              value={desc ?? a.description ?? ""}
              onChange={(e) => setDesc(e.target.value)}
              w={280}
            />
            <Select
              label="Group"
              placeholder="(none)"
              clearable
              data={(groups.data ?? []).map((g) => ({
                value: g.id,
                label: g.name,
              }))}
              value={groupId === undefined ? a.groupId : groupId}
              onChange={(v) => setGroupId(v)}
            />
            <Checkbox
              label="Debug only"
              checked={debugOnly ?? a.debugOnly}
              onChange={(e) => setDebugOnly(e.currentTarget.checked)}
              mb={8}
            />
            <Button type="submit" disabled={act.busy}>
              Save
            </Button>
            <Confirm
              label="Delete app"
              onConfirm={async () => {
                const ok = await act.run(async () => {
                  await api.deleteCatalogApp(a.name);
                  return true;
                });
                if (ok) void navigate("/catalog");
              }}
              disabled={act.busy}
            />
          </Group>
        </form>
      </Card>

      <UploadCard app={a} onUploaded={() => artifacts.reload()} />
      <SettingsCard app={a} />
      <CleanupCard app={a} onDone={() => artifacts.reload()} />
      {perms.error && <Notice kind="error">{perms.error}</Notice>}
      <CatalogPermissionsCard
        title="App permissions"
        permissions={perms.data ?? undefined}
        onGrant={async (login, level) => {
          const r = await api.grantCatalogAppPermission(a.name, login, level);
          perms.set(r);
          return r;
        }}
        onRevoke={async (pid) => {
          await api.revokeCatalogAppPermission(a.name, pid);
          await perms.reload();
        }}
      />

      <Title order={4} mb="xs">
        Artifacts
      </Title>
      {artifacts.error && <Notice kind="error">{artifacts.error}</Notice>}
      {artifacts.loading && !artifacts.data ? (
        <Spinner />
      ) : versionGroups.length ? (
        versionGroups.map((g) => (
          <Card withBorder mb="sm" padding="sm" key={g.version}>
            <Text size="sm" fw={600} mb={4}>
              {g.version}
            </Text>
            <Table.ScrollContainer minWidth={640}>
              <Table>
                <Table.Tbody>
                  {g.artifacts.map((art) => (
                    <Table.Tr key={art.id}>
                      <Table.Td>
                        <Badge tone="accent">{art.platform}</Badge>
                      </Table.Td>
                      <Table.Td>
                        <Anchor href={art.url} size="sm">
                          {art.objectKey?.split("/").pop() ?? art.url}
                        </Anchor>
                      </Table.Td>
                      <Table.Td>{fmtSize(art.size)}</Table.Td>
                      <Table.Td>{fmtTime(art.createdAt)}</Table.Td>
                      <Table.Td>
                        {art.ios &&
                          (iosDevice ? (
                            <Button
                              component="a"
                              href={art.ios.installUrl}
                              size="compact-sm"
                            >
                              Install on this device
                            </Button>
                          ) : (
                            <Text size="xs" c="dimmed">
                              iOS OTA: open this page on the device
                            </Text>
                          ))}
                      </Table.Td>
                      <Table.Td>
                        <Confirm
                          label="Delete"
                          onConfirm={async () => {
                            const ok = await act.run(async () => {
                              await api.deleteCatalogArtifact(a.name, art.id);
                              return true;
                            });
                            if (ok) await artifacts.reload();
                          }}
                          disabled={act.busy}
                        />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Card>
        ))
      ) : (
        <Text size="sm" c="dimmed">
          No artifacts yet.
        </Text>
      )}
    </>
  );
}
