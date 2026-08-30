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
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { Crumbs } from "../components/Crumbs";
import { Badge, Confirm, CopyField, Notice, Spinner } from "../components/ui";
import { fmtSize } from "../lib/catalog";
import { fmtTime } from "../lib/format";
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
    <Card withBorder mt="md" padding="sm">
      <Text size="sm" fw={600} mb={4}>
        Build for this base path
      </Text>
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
    </Card>
  );
}

function DeployCard({
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
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pick = (list: FileList | null) => setFile(list?.[0] ?? null);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    pick(e.dataTransfer.files);
  };
  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    const d = await act.run(() => api.deploySite(site, file));
    if (!d) return;
    setFile(null);
    await onDeployed(d);
  };
  return (
    <Card withBorder mb="md" padding="sm">
      <Text size="sm" fw={600} mb={4}>
        Deploy a zip
      </Text>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <Paper
        withBorder
        p="md"
        mb="sm"
        role="button"
        tabIndex={0}
        aria-label="Choose or drop the build zip"
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
          {file
            ? `${file.name} (${fmtSize(file.size)})`
            : "Drop the build zip here, or click to choose"}
        </Text>
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => pick(e.target.files)}
        />
      </Paper>
      <form onSubmit={(e) => void upload(e)}>
        <Group align="end" wrap="wrap">
          <Button type="submit" disabled={act.busy || !file || busy}>
            {busy ? "A deploy is in flight" : "Deploy"}
          </Button>
          <Text size="xs" c="dimmed">
            The previous files keep serving until the new set is complete; files
            missing from the new build are removed. Or from a terminal:{" "}
            <Code>yyt site deploy {"<site>"} dist/</Code>.
          </Text>
        </Group>
      </form>
    </Card>
  );
}

function DeployRows({ deploys }: { deploys: SiteDeploy[] }) {
  if (deploys.length === 0)
    return (
      <Text size="sm" c="dimmed">
        No deploys yet.
      </Text>
    );
  return (
    <Table.ScrollContainer minWidth={640}>
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Deploy</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Files</Table.Th>
            <Table.Th>Size</Table.Th>
            <Table.Th>Error</Table.Th>
            <Table.Th>Created</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {deploys.map((d) => (
            <Table.Tr key={d.id}>
              <Table.Td>
                <Code>{d.id}</Code>
              </Table.Td>
              <Table.Td>
                <Badge tone={STATUS_TONE[d.status]}>{d.status}</Badge>
              </Table.Td>
              <Table.Td>{d.files}</Table.Td>
              <Table.Td>{fmtSize(d.bytes)}</Table.Td>
              <Table.Td>{d.error ?? "—"}</Table.Td>
              <Table.Td>{fmtTime(d.createdAt)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

export function SitePage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const site = useApiQuery(["sites", "site", id], () => api.site(id));
  const standing = useTeamStanding(site.data?.teamId);
  const act = useAction();
  const [name, setName] = useState<string | null>(null);
  const [desc, setDesc] = useState<string | null>(null);

  // A deploy in flight: poll the site (which also heals a lost worker) every
  // 3 s until it settles, then stop — a page left open must not keep polling.
  const inFlight =
    site.data?.deploys.some((d) => isInFlight(d.status)) ?? false;
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
    if (!ok || !site.data) return;
    const s = site.data;
    void navigate(
      s.teamId && s.projectId
        ? projectUrl(s.teamId, s.projectId, "sites")
        : "/teams",
    );
  };

  const saveInfo = async (e: FormEvent) => {
    e.preventDefault();
    if (!site.data) return;
    const s = site.data;
    const body: { name?: string; description?: string | null } = {};
    if (name !== null && name.trim() !== s.name) body.name = name.trim();
    if (desc !== null) body.description = desc.trim() || null;
    if (Object.keys(body).length === 0) return;
    const r = await act.run(() => api.updateSite(id, body));
    if (!r) return;
    site.set({ ...s, ...r });
    setName(null);
    setDesc(null);
  };

  if (site.error) return <Notice kind="error">{site.error}</Notice>;
  if (!site.data) return <Spinner />;
  const s = site.data;
  const canWrite = standing.canWrite;

  return (
    <>
      <Crumbs crumbs={s} current={s.name} />
      <Group justify="space-between" align="start" mb="sm">
        <div>
          <Title order={2}>{s.name}</Title>
          <Text size="sm" c="dimmed">
            {s.description ?? "No description"} · created by{" "}
            {s.createdBy ?? "—"}
          </Text>
        </div>
        {canWrite && (
          <Confirm
            label="Delete site"
            confirmLabel="Delete everything"
            onConfirm={() => void remove()}
            disabled={act.busy || s.busy}
          />
        )}
      </Group>
      {!canWrite && !standing.loading && (
        <Notice>
          Read-only: you are not seated in this site&rsquo;s team.
        </Notice>
      )}
      <Notice kind="warn">{SITE_SHARED_ORIGIN_WARNING}</Notice>
      <Card withBorder mb="md" padding="sm">
        <Group gap="xs" mb={4} align="center">
          <Text size="sm" fw={600}>
            Public URL
          </Text>
          {s.currentDeploy ? (
            <Badge tone="ok">live</Badge>
          ) : (
            <Badge tone="neutral">nothing deployed</Badge>
          )}
        </Group>
        <Anchor href={s.publicUrl} target="_blank" rel="noopener noreferrer">
          {s.publicUrl}
        </Anchor>
        <CopyField label="URL" value={s.publicUrl} />
      </Card>
      {canWrite && (
        <Card withBorder mb="md" padding="sm">
          <form onSubmit={(e) => void saveInfo(e)}>
            <Group align="end" wrap="wrap">
              <TextInput
                label="Name"
                value={name ?? s.name}
                onChange={(e) => setName(e.target.value)}
                maxLength={64}
                w={200}
              />
              <TextInput
                label="Description"
                value={desc ?? s.description ?? ""}
                onChange={(e) => setDesc(e.target.value)}
                maxLength={2000}
                w={280}
              />
              <Button type="submit" disabled={act.busy}>
                Save
              </Button>
            </Group>
          </form>
        </Card>
      )}
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {canWrite && (
        <DeployCard site={id} busy={s.busy} onDeployed={() => site.reload()} />
      )}
      <Text size="sm" fw={600} mb={4}>
        Deploys
      </Text>
      <DeployRows deploys={s.deploys} />
      <BuildHints basePath={s.basePath} />
    </>
  );
}
