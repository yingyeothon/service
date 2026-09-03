import {
  Anchor,
  Button,
  Code,
  Divider,
  Group,
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api, ApiError } from "../api";
import { Crumbs } from "../components/Crumbs";
import { DataTable } from "../components/DataTable";
import { PageSkeleton } from "../components/Loading";
import { PageHeader, type HeaderAction } from "../components/PageHeader";
import { ReadOnlyBanner } from "../components/ReadOnlyBanner";
import { ResourceDrawer, useDrawerForm } from "../components/ResourceDrawer";
import { RowMenu } from "../components/RowMenu";
import { Section } from "../components/Section";
import { Badge, DropZone, Notice } from "../components/ui";
import {
  artifactLabels,
  artifactTagRows,
  fmtSize,
  groupArtifactsByVersion,
  isIosUserAgent,
} from "../lib/catalog";
import { useConfirm } from "../lib/confirm";
import { fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { useAction, useApiQuery } from "../lib/query";
import { projectUrl, useTeamStanding } from "../lib/team";
import {
  CATALOG_PLATFORMS,
  type CatalogApp,
  type CatalogArtifact,
  type CatalogCleanupResult,
  type CatalogPlatform,
  type CatalogSettings,
} from "../types";

/** Best-effort platform guess from the chosen file. */
function guessPlatform(filename: string): CatalogPlatform | null {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (ext === ".apk" || ext === ".aab") return "android";
  if (ext === ".ipa") return "ios";
  return null;
}

function UploadSection({
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

  const pick = (f: File | null) => {
    setFile(f);
    if (f) {
      const guessed = guessPlatform(f.name);
      if (guessed) setPlatform(guessed);
    }
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
      api.uploadCatalogArtifact(app.id, file, platform, tags),
    );
    if (!r) return;
    setFile(null);
    setVersion("");
    notify.done(
      r.version
        ? `Artifact ${tags.version} uploaded · linked to version ${r.version.name}`
        : `Artifact ${tags.version} uploaded`,
    );
    await onUploaded();
  };

  return (
    <Section title="Upload artifact">
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <form onSubmit={(e) => void upload(e)}>
        <DropZone
          label="Choose or drop a file"
          dimmed={!file}
          onFiles={(l) => pick(l?.[0] ?? null)}
        >
          {file
            ? `${file.name} (${fmtSize(file.size)})`
            : "Drag & drop a file here, or click to choose"}
        </DropZone>
        <Group align="end" wrap="wrap">
          <Select
            label="Platform"
            data={[...CATALOG_PLATFORMS]}
            value={platform}
            onChange={(v) => setPlatform((v as CatalogPlatform) ?? "android")}
            allowDeselect={false}
            w={140}
          />
          <TextInput
            label="Version"
            placeholder="1.2.3"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            required
            w={140}
            autoComplete="off"
            spellCheck={false}
          />
          {platform === "android" && (
            <Select
              label="Build type"
              placeholder="(none)"
              clearable
              data={["debug", "release", "appbundle"]}
              value={buildType}
              onChange={setBuildType}
              w={160}
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
              w={160}
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
                w={200}
              />
              <TextInput
                label="Build number"
                placeholder="42"
                value={buildNumber}
                onChange={(e) => setBuildNumber(e.target.value)}
                required
                w={120}
              />
            </>
          )}
          <Button
            type="submit"
            variant="default"
            disabled={act.busy || !file || !version.trim()}
            loading={act.busy}
          >
            Upload
          </Button>
        </Group>
      </form>
    </Section>
  );
}

function CleanupSection({
  app,
  onDone,
}: {
  app: CatalogApp;
  onDone: () => Promise<void>;
}) {
  const act = useAction();
  const confirm = useConfirm();
  const [result, setResult] = useState<CatalogCleanupResult | null>(null);
  const run = async (dryRun: boolean) => {
    const r = await act.run(() => api.cleanupCatalogArtifacts(app.id, dryRun));
    if (!r) return;
    setResult(r);
    if (!dryRun) {
      notify.done(`Deleted ${r.deleted} artifact(s)`);
      await onDone();
    }
  };
  const runForReal = async () => {
    const r = await confirm({
      title: "Run the retention cleanup?",
      message:
        "Artifacts beyond the kept versions are deleted from the CDN. Preview first to see which.",
      confirmLabel: "Run cleanup",
      danger: true,
    });
    if (r.ok) await run(false);
  };
  return (
    <Section
      title="Retention cleanup"
      description="Keeps the most recent versions (the number is in Edit) and deletes the rest."
      actions={
        <>
          <Button
            variant="default"
            onClick={() => void run(true)}
            disabled={act.busy}
          >
            Preview (dry run)
          </Button>
          <Button
            variant="default"
            onClick={() => void runForReal()}
            disabled={act.busy}
          >
            Run cleanup
          </Button>
        </>
      }
    >
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {result ? (
        <Text size="sm" c="dimmed">
          {result.executed
            ? `Deleted ${result.deleted} artifact(s)` +
              (result.s3Failures ? `, ${result.s3Failures} S3 failure(s)` : "")
            : `Would delete ${result.preview.deletions.length} of ${result.preview.totalArtifacts} artifact(s) (keep ${result.preview.keepRecentVersions} versions): ` +
              result.preview.deletions
                .map((d) => `${d.version}/${d.platform} (${d.reason})`)
                .join(", ")}
        </Text>
      ) : (
        <Text size="sm" c="dimmed">
          Nothing run yet.
        </Text>
      )}
    </Section>
  );
}

/** Lines the cell shows before it clamps; the tooltip always has the whole. */
const CHANGELOG_LINES = 4;

/**
 * The changelog cell: the one upload tag long enough to be worth a column of
 * its own, with the artifact's other upload tags — and the changelog in full,
 * since the cell clamps — on a tooltip over it. An expander below the table
 * was the first shape of this and it was wrong: the row and its metadata
 * never shared a screen.
 */
function ChangelogCell({ artifact }: { artifact: CatalogArtifact }) {
  const changelog = artifact.tags.changelog?.trim() ?? "";
  // `version` has a column; everything else the upload sent is here. The
  // changelog leads because a clamped cell cannot be measured from here —
  // guessing whether it clipped is the one thing this must not do.
  const tags = [
    ...(changelog ? [{ key: "changelog", value: changelog }] : []),
    ...artifactTagRows(artifact).filter(
      (t) => t.key !== "changelog" && t.key !== "version",
    ),
  ];
  // A span, not the default paragraph: the tooltip target below wraps it.
  const text = (
    <Text
      component="span"
      size="sm"
      c={changelog ? undefined : "dimmed"}
      lineClamp={CHANGELOG_LINES}
      style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
    >
      {changelog || "—"}
    </Text>
  );
  if (tags.length === 0) return <Table.Td>{text}</Table.Td>;
  return (
    <Table.Td>
      <Tooltip
        multiline
        w={280}
        position="top-start"
        events={{ hover: true, focus: true, touch: true }}
        label={
          <Stack gap={2}>
            {tags.map((t) => (
              <Text key={t.key} size="xs" style={{ wordBreak: "break-word" }}>
                <b>{t.key}</b> {t.value}
              </Text>
            ))}
          </Stack>
        }
      >
        {/*
         * Focusable so the tooltip is reachable without a pointer, and a
         * block so the whole cell is the target — a row whose only tag is a
         * build type would otherwise hide it all behind one em dash.
         */}
        <span
          tabIndex={0}
          style={{
            display: "block",
            cursor: "help",
            textDecoration: "underline dotted",
            textUnderlineOffset: 3,
          }}
        >
          {text}
        </span>
      </Tooltip>
    </Table.Td>
  );
}

interface EditForm {
  name: string;
  path: string;
  description: string;
  slackHookUrl: string;
  slackChannel: string;
  messageTemplate: string;
  keepRecentVersions: number | string;
}

export function CatalogAppPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const app = useApiQuery(["catalog", "app", id], () => api.catalogApp(id));
  const artifacts = useApiQuery(["catalog", "app", id, "artifacts"], () =>
    api.catalogArtifacts(id),
  );
  const standing = useTeamStanding(app.data?.teamId);
  // Members only (the hook URL is a credential): a 403 hides the fields.
  const settings = useApiQuery(
    ["catalog", "app", id, "settings"],
    async () => {
      try {
        return await api.catalogSettings(id);
      } catch (e) {
        // `null` = not a member. TanStack Query v5 rejects `undefined`.
        if (e instanceof ApiError && (e.status === 403 || e.status === 404))
          return null;
        throw e;
      }
    },
    { enabled: standing.canWrite },
  );
  const act = useAction();
  const iosDevice = isIosUserAgent(navigator.userAgent);
  const a = app.data;
  const s = settings.data ?? null;
  const edit = useDrawerForm<EditForm>(() => ({
    name: a?.name ?? "",
    path: a?.path ?? "",
    description: a?.description ?? "",
    slackHookUrl: s?.slackHookUrl ?? "",
    slackChannel: s?.slackChannel ?? "",
    messageTemplate: s?.messageTemplate ?? "",
    keepRecentVersions: s?.keepRecentVersions ?? 5,
  }));

  const crumbs = <Crumbs crumbs={a ?? {}} current={a?.name} />;
  if (app.error)
    return (
      <>
        {crumbs}
        <PageHeader />
        <Notice kind="error">{app.error}</Notice>
      </>
    );
  if (!a)
    return (
      <>
        {crumbs}
        <PageHeader />
        <PageSkeleton />
      </>
    );
  const canWrite = standing.canWrite;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const info: { name?: string; path?: string; description?: string | null } =
      {};
    const f = edit.form;
    if (f.name.trim() !== a.name) info.name = f.name.trim();
    if (f.path.trim() !== a.path) info.path = f.path.trim();
    if (f.description.trim() !== (a.description ?? ""))
      info.description = f.description.trim() || null;
    const cfg: Partial<CatalogSettings> = {};
    if (s) {
      if (f.slackHookUrl.trim() !== (s.slackHookUrl ?? ""))
        cfg.slackHookUrl = f.slackHookUrl.trim() || null;
      if (f.slackChannel.trim() !== (s.slackChannel ?? ""))
        cfg.slackChannel = f.slackChannel.trim() || null;
      if (f.messageTemplate.trim() !== (s.messageTemplate ?? ""))
        cfg.messageTemplate = f.messageTemplate.trim() || null;
      if (
        typeof f.keepRecentVersions === "number" &&
        f.keepRecentVersions !== s.keepRecentVersions
      )
        cfg.keepRecentVersions = f.keepRecentVersions;
    }
    if (Object.keys(info).length === 0 && Object.keys(cfg).length === 0) {
      edit.close();
      return;
    }
    const ok = await act.run(async () => {
      if (Object.keys(info).length > 0) {
        const r = await api.updateCatalogApp(a.id, info);
        app.set(r);
      }
      if (Object.keys(cfg).length > 0) {
        const r = await api.updateCatalogSettings(a.id, cfg);
        settings.set(r);
      }
      return true;
    });
    if (!ok) return;
    edit.close();
    notify.saved("app");
  };
  const remove = async () => {
    const ok = await act.run(async () => {
      await api.deleteCatalogApp(a.id);
      return true;
    });
    if (!ok) return;
    notify.deleted("app");
    void navigate(
      a.teamId && a.projectId
        ? projectUrl(a.teamId, a.projectId, "catalog")
        : "/teams",
    );
  };
  const removeArtifact = async (artifactId: string) => {
    const ok = await act.run(async () => {
      await api.deleteCatalogArtifact(a.id, artifactId);
      return true;
    });
    if (ok) {
      notify.deleted("artifact");
      await artifacts.reload();
    }
  };

  const rows = groupArtifactsByVersion(artifacts.data ?? []).flatMap((g) =>
    g.artifacts.map((art, i) => ({
      ...art,
      version: g.version,
      first: i === 0,
    })),
  );
  const labels = artifactLabels(rows);
  const labelOf = (art: { id: string }) => labels.get(art.id) ?? art.id;
  // The drawer seeds its settings fields from `s`; opening it before the
  // settings arrived would diff blanks against them and wipe them on save.
  const settingsPending = canWrite && settings.data === undefined;
  const actions: HeaderAction[] = canWrite
    ? [
        {
          label: "Edit",
          onClick: () => {
            act.clear();
            edit.open();
          },
          disabled: settingsPending,
        },
      ]
    : [];

  return (
    <>
      {crumbs}
      <PageHeader
        title={a.name}
        description={a.description ?? undefined}
        meta={
          <>
            <Code>{a.path}</Code> · created by {a.createdBy ?? "—"} ·{" "}
            {fmtTime(a.createdAt)} · id <Code>{a.id}</Code>
          </>
        }
        actions={actions}
      />
      {!canWrite && !standing.loading && <ReadOnlyBanner />}
      {act.error && !edit.opened && <Notice kind="error">{act.error}</Notice>}
      {canWrite && (
        <UploadSection app={a} onUploaded={() => artifacts.reload()} />
      )}
      <Section title="Artifacts">
        <DataTable
          columns={[
            { key: "version", label: "Version" },
            { key: "platform", label: "Platform" },
            { key: "file", label: "File" },
            { key: "size", label: "Size", align: "right" },
            { key: "created", label: "Created" },
            { key: "changelog", label: "Changelog", width: 280 },
            { key: "install", label: "" },
          ]}
          rows={artifacts.data ? rows : undefined}
          loading={artifacts.loading}
          error={artifacts.error}
          rowKey={(art) => art.id}
          minWidth={920}
          empty={{ title: "No artifacts yet." }}
          render={(art) => (
            <>
              <Table.Td>
                {art.first && (
                  <Text size="sm" fw={500}>
                    {art.version}
                  </Text>
                )}
              </Table.Td>
              <Table.Td>
                <Badge tone="accent">{art.platform}</Badge>
              </Table.Td>
              <Table.Td>
                <Anchor href={art.url} size="sm">
                  {art.objectKey?.split("/").pop() ?? art.url}
                </Anchor>
              </Table.Td>
              <Table.Td style={{ textAlign: "right" }}>
                {fmtSize(art.size)}
              </Table.Td>
              <Table.Td>{fmtTime(art.createdAt)}</Table.Td>
              <ChangelogCell artifact={art} />
              <Table.Td>
                {art.ios &&
                  (iosDevice ? (
                    <Button
                      component="a"
                      href={art.ios.installUrl}
                      size="compact-sm"
                      variant="default"
                    >
                      Install on this device
                    </Button>
                  ) : (
                    <Text size="xs" c="dimmed">
                      iOS OTA: open this page on the device
                    </Text>
                  ))}
              </Table.Td>
            </>
          )}
          actions={
            canWrite
              ? (art) => (
                  <RowMenu
                    name={labelOf(art)}
                    items={[
                      {
                        label: "Delete artifact",
                        danger: true,
                        disabled: act.busy,
                        onClick: () => removeArtifact(art.id),
                        confirm: {
                          title: `Delete ${labelOf(art)}?`,
                          message: "The file is removed from the CDN.",
                          confirmLabel: "Delete artifact",
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
      {canWrite && <CleanupSection app={a} onDone={() => artifacts.reload()} />}
      <ResourceDrawer
        opened={edit.opened}
        onClose={edit.close}
        title="Edit app"
        submitLabel="Save"
        onSubmit={save}
        busy={act.busy}
        error={edit.opened ? (act.error ?? settings.error) : null}
        disabled={
          !edit.form.name.trim() ||
          !edit.form.path.trim() ||
          settings.error !== null
        }
        danger={{
          label: "Delete app",
          description: "Every artifact goes with it.",
          onConfirm: remove,
          disabled: act.busy,
        }}
      >
        <TextInput
          label="Name"
          value={edit.form.name}
          onChange={(e) => edit.patch({ name: e.currentTarget.value })}
          required
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          data-autofocus
        />
        <TextInput
          label="Application id"
          value={edit.form.path}
          onChange={(e) => edit.patch({ path: e.currentTarget.value })}
          required
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
        />
        <TextInput
          label="Description"
          placeholder="optional"
          value={edit.form.description}
          onChange={(e) => edit.patch({ description: e.currentTarget.value })}
          maxLength={2000}
          autoComplete="off"
        />
        {s && (
          <>
            <Divider label="Notifications and retention" labelPosition="left" />
            <TextInput
              label="Slack webhook URL"
              placeholder="https://hooks.slack.com/services/…"
              value={edit.form.slackHookUrl}
              onChange={(e) =>
                edit.patch({ slackHookUrl: e.currentTarget.value })
              }
              autoComplete="off"
              spellCheck={false}
            />
            <TextInput
              label="Slack channel"
              placeholder="#releases"
              value={edit.form.slackChannel}
              onChange={(e) =>
                edit.patch({ slackChannel: e.currentTarget.value })
              }
              autoComplete="off"
            />
            <TextInput
              label="Message template"
              placeholder="{{app}} {{version}} ({{stage}}) uploaded"
              value={edit.form.messageTemplate}
              onChange={(e) =>
                edit.patch({ messageTemplate: e.currentTarget.value })
              }
              autoComplete="off"
            />
            <NumberInput
              label="Keep recent versions"
              min={1}
              max={100}
              value={edit.form.keepRecentVersions}
              onChange={(v) => edit.patch({ keepRecentVersions: v })}
            />
          </>
        )}
      </ResourceDrawer>
    </>
  );
}
