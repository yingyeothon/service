import { Anchor, Button, Code, Group, Table, Text } from "@mantine/core";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { Crumbs } from "../components/Crumbs";
import { DataTable } from "../components/DataTable";
import { PageSkeleton } from "../components/Loading";
import { NameDescriptionFields } from "../components/NameDescriptionFields";
import { PageHeader, type HeaderAction } from "../components/PageHeader";
import { ReadOnlyBanner } from "../components/ReadOnlyBanner";
import { ResourceDrawer, useDrawerForm } from "../components/ResourceDrawer";
import { Section } from "../components/Section";
import { Badge, CopyField, DropZone, Notice } from "../components/ui";
import { fmtSize } from "../lib/catalog";
import { fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { useAction, useApiQuery } from "../lib/query";
import { projectUrl, useTeamStanding } from "../lib/team";
import type { SiteDeploy, SiteDeployStatus } from "../types";

/** Byte-identical to `SITE_SHARED_ORIGIN_WARNING` (console) and the CLI help. */
export const SITE_SHARED_ORIGIN_WARNING =
  "Every site on this host shares one origin: another site here can read this page, its storage and its in-memory state (same-origin frames). Never keep a credential (JWT, API token) in localStorage, sessionStorage or IndexedDB; use short-lived tokens minted per session and treat this host as untrusted.";

const IN_FLIGHT: SiteDeployStatus[] = ["queued", "extracting"];
export const isInFlight = (s: SiteDeployStatus) => IN_FLIGHT.includes(s);

const STATUS_TONE: Record<SiteDeployStatus, string> = {
  pending: "neutral",
  queued: "warn",
  extracting: "warn",
  live: "ok",
  failed: "danger",
};

/** Build hints for the base path a site reports (decision 5). */
export function BuildHints({ basePath }: { basePath: string }) {
  return (
    <Section title="Build for this base path">
      <Text size="sm" c="dimmed" mb="xs">
        Pages are served under <Code>{basePath}</Code>, so absolute{" "}
        <Code>/assets/…</Code> references break. Use relative URLs or the base
        path: vite <Code>base: &quot;./&quot;</Code> or{" "}
        <Code>base: &quot;{basePath}&quot;</Code>; Flutter{" "}
        <Code>--base-href {basePath}</Code>; Unity/Godot exports are relative
        already. Runtime config is a file in the build (for example{" "}
        <Code>config.json</Code>) — never a token. The zip must hold{" "}
        <Code>index.html</Code> at its root (a zipped folder is unwrapped); at
        most 5 MiB compressed, 50 MB and 2000 files extracted.
      </Text>
      <CopyField label="Base path" value={basePath} />
    </Section>
  );
}

function DeploySection({
  site,
  busy,
  onDeployed,
}: {
  site: string;
  busy: boolean;
  onDeployed: (d: SiteDeploy) => Promise<void>;
}) {
  const act = useAction();
  const [file, setFile] = useState<File | null>(null);
  const pick = (list: FileList | null) => setFile(list?.[0] ?? null);
  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    const d = await act.run(() => api.deploySite(site, file));
    if (!d) return;
    setFile(null);
    notify.done("Deploy started");
    await onDeployed(d);
  };
  return (
    <Section
      title="Deploy"
      description={
        <>
          The previous files keep serving until the new set is complete; files
          missing from the new build are removed. Or from a terminal:{" "}
          <Code>yyt site deploy {"<site>"} dist/</Code>.
        </>
      }
    >
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <form onSubmit={(e) => void upload(e)}>
        <DropZone
          label="Choose or drop the build zip"
          accept=".zip,application/zip"
          onFiles={pick}
        >
          {file
            ? `${file.name} (${fmtSize(file.size)})`
            : "Drop the build zip here, or click to choose"}
        </DropZone>
        <Group>
          <Button
            type="submit"
            variant="default"
            disabled={act.busy || !file || busy}
            loading={act.busy}
          >
            {busy ? "A deploy is in flight" : "Deploy"}
          </Button>
        </Group>
      </form>
    </Section>
  );
}

export function SitePage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const site = useApiQuery(["sites", "site", id], () => api.site(id));
  const standing = useTeamStanding(site.data?.teamId);
  const act = useAction();
  const s = site.data;
  const edit = useDrawerForm(() => ({
    name: s?.name ?? "",
    description: s?.description ?? "",
  }));

  // A deploy in flight: poll the site (which also heals a lost worker) every
  // 3 s until it settles, then stop — a page left open must not keep polling.
  const inFlight = s?.deploys.some((d) => isInFlight(d.status)) ?? false;
  const reload = site.reload;
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [inFlight, reload]);

  const remove = async () => {
    const ok = await act.run(async () => {
      await api.deleteSite(id);
      return true;
    });
    if (!ok || !s) return;
    notify.deleted("site");
    void navigate(
      s.teamId && s.projectId
        ? projectUrl(s.teamId, s.projectId, "sites")
        : "/teams",
    );
  };

  const saveInfo = async (e: FormEvent) => {
    e.preventDefault();
    if (!s) return;
    const body: { name?: string; description?: string | null } = {};
    const name = edit.form.name.trim();
    if (name !== s.name) body.name = name;
    const desc = edit.form.description.trim();
    if (desc !== (s.description ?? "")) body.description = desc || null;
    if (Object.keys(body).length === 0) {
      edit.close();
      return;
    }
    const r = await act.run(() => api.updateSite(id, body));
    if (!r) return;
    site.set({ ...s, ...r });
    edit.close();
    notify.saved("site");
  };

  const crumbs = <Crumbs crumbs={s ?? {}} current={s?.name} />;
  if (site.error)
    return (
      <>
        {crumbs}
        <PageHeader />
        <Notice kind="error">{site.error}</Notice>
      </>
    );
  if (!s)
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
        title={s.name}
        badges={
          s.currentDeploy ? (
            <Badge tone="ok">live</Badge>
          ) : (
            <Badge tone="neutral">nothing deployed</Badge>
          )
        }
        description={s.description ?? undefined}
        meta={
          <>
            Created by {s.createdBy ?? "—"} · {fmtTime(s.createdAt)} · id{" "}
            <Code>{s.id}</Code>
          </>
        }
        actions={actions}
      />
      {!canWrite && !standing.loading && <ReadOnlyBanner />}
      <Notice kind="warn">{SITE_SHARED_ORIGIN_WARNING}</Notice>
      {act.error && !edit.opened && <Notice kind="error">{act.error}</Notice>}
      <Section title="Public URL">
        <Anchor href={s.publicUrl} target="_blank" rel="noopener noreferrer">
          {s.publicUrl}
        </Anchor>
        <CopyField label="URL" value={s.publicUrl} />
      </Section>
      {canWrite && (
        <DeploySection
          site={id}
          busy={s.busy}
          onDeployed={() => site.reload()}
        />
      )}
      <Section title="Deploys">
        <DataTable
          columns={[
            { key: "id", label: "Deploy" },
            { key: "status", label: "Status" },
            { key: "files", label: "Files", align: "right" },
            { key: "size", label: "Size", align: "right" },
            { key: "error", label: "Error" },
            { key: "created", label: "Created" },
          ]}
          rows={s.deploys}
          rowKey={(d) => d.id}
          minWidth={640}
          empty={{ title: "No deploys yet." }}
          render={(d) => (
            <>
              <Table.Td>
                <Code>{d.id}</Code>
              </Table.Td>
              <Table.Td>
                <Badge tone={STATUS_TONE[d.status]}>{d.status}</Badge>
              </Table.Td>
              <Table.Td style={{ textAlign: "right" }}>{d.files}</Table.Td>
              <Table.Td style={{ textAlign: "right" }}>
                {fmtSize(d.bytes)}
              </Table.Td>
              <Table.Td>{d.error ?? "—"}</Table.Td>
              <Table.Td>{fmtTime(d.createdAt)}</Table.Td>
            </>
          )}
        />
      </Section>
      <BuildHints basePath={s.basePath} />
      <ResourceDrawer
        opened={edit.opened}
        onClose={edit.close}
        title="Edit site"
        submitLabel="Save"
        onSubmit={saveInfo}
        busy={act.busy}
        disabled={!edit.form.name.trim()}
        error={edit.opened ? act.error : null}
        danger={{
          label: "Delete site",
          description: "Every deploy and the public URL go with it.",
          onConfirm: remove,
          disabled: act.busy || s.busy,
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
