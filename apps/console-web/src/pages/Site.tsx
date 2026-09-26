import {
  Anchor,
  Button,
  Code,
  Group,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { Clipped } from "../components/Clipped";
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
import { useListQuery } from "../lib/listQuery";
import { useAction, useApiQuery } from "../lib/query";
import { projectUrl, useTeamStanding } from "../lib/team";
import type { Site, SiteDeploy, SiteDeployStatus } from "../types";

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

/*
 * A name is at most 32 characters. Past this many the move target is
 * clipped (full text on tap or hover), or a 32-character target beside a
 * long error code pushes the deploy table past the page (measured
 * 2026-09-26: 1079–1095 px of min-content against 1048 px at `maw` 1080).
 */
const MOVE_TARGET_CHARS = 18;
const MOVE_TARGET_WIDTH = 144;

/** A deploy's kind cell: `upload`, or `move → <target>` on one line. */
function DeployKind({ d }: { d: SiteDeploy }) {
  if (d.kind !== "move") return <>upload</>;
  const to = d.moveTo ?? "?";
  if (to.length <= MOVE_TARGET_CHARS)
    return (
      <>
        move → <Code>{to}</Code>
      </>
    );
  return (
    <Clipped
      text={to}
      width={MOVE_TARGET_WIDTH}
      what={`Move target of ${d.id}`}
      prefix={<span>move →</span>}
    />
  );
}

type SiteUrls = Pick<Site, "domain" | "hostUrl" | "publicUrl">;

/**
 * The link a site is reached by (docs/decisions.md *Site domains* §10): its
 * own host only once it has a name, because an unnamed site may be a
 * `/{slug}/` build that works on the path host alone.
 */
export function sitePrimaryUrl(s: SiteUrls): string {
  return s.domain ? (s.hostUrl ?? s.publicUrl) : s.publicUrl;
}

/** The other URLs the same files answer on, labelled. */
export function siteOtherUrls(s: SiteUrls): { label: string; url: string }[] {
  const primary = sitePrimaryUrl(s);
  const out: { label: string; url: string }[] = [];
  if (s.hostUrl && s.hostUrl !== primary)
    out.push({ label: "Site host", url: s.hostUrl });
  if (s.publicUrl !== primary)
    out.push({ label: "Path URL", url: s.publicUrl });
  return out;
}

/** `g.yyt.life` from `https://g.yyt.life/abc/` (the path host). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Build hints for the URLs a site reports (docs/decisions.md *Static sites*
 * §5, *Site domains* §10): a relative base works on both hosts, `/` only on
 * the site's own host, `/{slug}/` only on the path host.
 */
export function BuildHints({
  basePath,
  hostUrl,
}: {
  basePath: string;
  hostUrl?: string | null;
}) {
  return (
    <Section title="Build for these URLs">
      <Text size="sm" c="dimmed" mb="xs">
        A relative base works on every URL of the site: vite{" "}
        <Code>base: &quot;./&quot;</Code>; Unity/Godot exports are relative
        already.{" "}
        {hostUrl ? (
          <>
            An absolute <Code>/</Code> base (<Code>/assets/…</Code> references,
            Flutter <Code>--base-href /</Code>) works only on the site
            host.{" "}
          </>
        ) : (
          <>
            Absolute <Code>/assets/…</Code> references break.{" "}
          </>
        )}
        The base path <Code>{basePath}</Code> (vite{" "}
        <Code>base: &quot;{basePath}&quot;</Code>, Flutter{" "}
        <Code>--base-href {basePath}</Code>) works only on the path URL, and
        claiming or changing the name changes it: rebuild such a build after a
        rename. Runtime config is a file in the build (for example{" "}
        <Code>config.json</Code>) — never a token. The zip must hold{" "}
        <Code>index.html</Code> at its root (a zipped folder is unwrapped); at
        most 5 MiB compressed, 50 MB and 2000 files extracted.
      </Text>
      <CopyField label="Base path" value={basePath} />
    </Section>
  );
}

interface ErrorShape {
  status?: number;
  details?: unknown;
}

const sentence = (m: string) =>
  `${m.charAt(0).toUpperCase()}${m.slice(1)}${/[.!?]$/.test(m) ? "" : "."}`;

/** A 400's validation message for one body path, as a sentence, or null. */
function pathError(e: unknown, path: string): string | null {
  if (!(e instanceof Error)) return null;
  const { status, details } = e as ErrorShape;
  if (status !== 400 || !Array.isArray(details)) return null;
  const hit = (details as { path?: string; message?: string }[]).find(
    (d) => d.path === path,
  );
  return hit ? sentence(hit.message ?? "invalid value") : null;
}

/**
 * The text shown under the Domain field for a refusal about the name
 * (docs/decisions.md *Site domains* §3–8), or null for any other error —
 * those stay in the drawer's own error notice.
 */
export function domainError(e: unknown): string | null {
  if (!(e instanceof Error)) return null;
  const { status, details } = e as ErrorShape;
  if (status === 400) return pathError(e, "domain");
  const d = (details && typeof details === "object" ? details : {}) as {
    reason?: string;
    names?: { name: string }[];
    retryAfterMs?: number;
  };
  if (status === 409)
    switch (d.reason) {
      case "domain_taken":
        return "This name is taken. A name that has served files stays with the team that used it.";
      case "domain_cap": {
        const names = (d.names ?? []).map((n) => n.name);
        return `This team is at its limit of names in use or released in the last 30 days${names.length ? ` (${names.join(", ")})` : ""}. Reuse one of them, or wait for a released one to age out.`;
      }
      case "domain_cleaning":
        return "This name is still being cleaned up; try again in a minute.";
      default:
        return null;
    }
  if (status === 429)
    return d.retryAfterMs
      ? `One name change per team per second: try again in ${Math.max(1, Math.ceil(d.retryAfterMs / 1000))} s.`
      : `${sentence(e.message)} A rename counts as a deploy.`;
  return null;
}

const EDIT_FIELDS = ["name", "description", "domain"] as const;
type EditField = (typeof EDIT_FIELDS)[number];
export type SiteFieldErrors = Partial<Record<EditField, string>>;

/**
 * The refusals the edit drawer shows under their fields, for the keys the
 * request sent: a 400's per-path messages (a name and a domain can both be
 * wrong at once) and the name refusals of *Site domains* §4–8. Empty when
 * the error belongs to the drawer's notice (a busy site, a server fault).
 */
export function siteFieldErrors(
  e: unknown,
  sent: Partial<Record<EditField, unknown>>,
): SiteFieldErrors {
  const out: SiteFieldErrors = {};
  for (const f of EDIT_FIELDS) {
    if (!(f in sent)) continue;
    const m = f === "domain" ? domainError(e) : pathError(e, f);
    if (m) out[f] = m;
  }
  return out;
}

export interface SiteEditForm {
  name: string;
  description: string;
  domain: string;
  /**
   * What the drawer opened with — the domain re-seeded when a move lands
   * while it is open. A key is sent only when its field differs from this,
   * never from the live (polled) site: comparing a stale field with a moved
   * site's new name would send `domain: null` and undo the move.
   */
  seed: {
    name: string;
    description: string;
    domain: string | null | undefined;
  };
}

export interface SitePatch {
  name?: string;
  description?: string | null;
  domain?: string | null;
}

/** The PATCH body: only the fields changed since the drawer opened. */
export function sitePatch(f: SiteEditForm): SitePatch {
  const body: SitePatch = {};
  const name = f.name.trim();
  if (name !== f.seed.name) body.name = name;
  const desc = f.description.trim();
  if (desc !== f.seed.description) body.description = desc || null;
  // Only a changed domain is sent: every name request spends the team's
  // one-per-second slot and, when it moves files, a deploy.
  const domain = f.domain.trim().toLowerCase();
  if (f.seed.domain !== undefined && domain !== (f.seed.domain ?? ""))
    body.domain = domain || null;
  return body;
}

/** A deploy or a move holds the site: a domain change would be a 409. */
const siteHeld = (s: Pick<Site, "busy" | "movingTo">) => s.busy || !!s.movingTo;

/** The claimed name: lower-case, blank moves the site back to a random path. */
function DomainField({
  site,
  value,
  onChange,
  error,
}: {
  site: Site;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
}) {
  const suffix = site.hostSuffix ? `.${site.hostSuffix}` : null;
  const pathHint = `${hostOf(site.publicUrl)}/<name>/`;
  return (
    <>
      <TextInput
        label="Domain"
        description={
          suffix
            ? `Also served at ${pathHint}. 3–32 of a–z, 0–9 and -; blank moves back to a random path.`
            : `Served at ${pathHint}. 3–32 of a–z, 0–9 and -; blank moves back to a random path.`
        }
        placeholder="my-game"
        value={value}
        onChange={(e) => onChange(e.currentTarget.value.toLowerCase())}
        rightSection={
          suffix ? (
            <Text size="sm" c="dimmed" component="span">
              {suffix}
            </Text>
          ) : undefined
        }
        rightSectionWidth={suffix ? `${suffix.length + 2}ch` : undefined}
        rightSectionPointerEvents="none"
        maxLength={32}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        disabled={siteHeld(site)}
        error={error}
      />
      <Text size="xs" c="dimmed">
        {siteHeld(site)
          ? "A deploy or a move is in flight; the domain can change once it settles. "
          : ""}
        Changing it moves the files: the old URLs stop working when the move
        completes, and a <Code>{site.basePath}</Code> build must be rebuilt. A
        name that has served files stays with this team.
      </Text>
    </>
  );
}

function DeploySection({
  site,
  busy,
  moving,
  onDeployed,
}: {
  site: string;
  busy: boolean;
  moving: boolean;
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
            {busy
              ? moving
                ? "A move is in flight"
                : "A deploy is in flight"
              : "Deploy"}
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
  // The detail embeds the newest deploys; a chosen order asks the list route.
  const lq = useListQuery({ scope: id });
  const ordered = useApiQuery(
    ["sites", "site", id, "deploys", lq.params],
    () => api.siteDeploys(id, lq.params),
    { enabled: !!site.data && !!lq.sort, keepPrevious: true },
  );
  const act = useAction();
  const [fieldErrs, setFieldErrs] = useState<SiteFieldErrors>({});
  const s = site.data;
  const edit = useDrawerForm<SiteEditForm>(() => ({
    name: s?.name ?? "",
    description: s?.description ?? "",
    domain: s?.domain ?? "",
    seed: {
      name: s?.name ?? "",
      description: s?.description ?? "",
      domain: s?.domain,
    },
  }));
  const clearFieldErr = (f: EditField) =>
    setFieldErrs((e) => (e[f] ? { ...e, [f]: undefined } : e));

  // A move that lands while the drawer is open changes the site's name: an
  // untouched Domain field follows it (and so does the seed), so the form
  // never shows, or sends, a name the site no longer has.
  const liveDomain = s?.domain;
  const { opened: editing, setForm } = edit;
  useEffect(() => {
    if (!editing) return;
    setForm((f) =>
      f.seed.domain === liveDomain || f.domain !== (f.seed.domain ?? "")
        ? f
        : {
            ...f,
            domain: liveDomain ?? "",
            seed: { ...f.seed, domain: liveDomain },
          },
    );
  }, [editing, liveDomain, setForm]);

  // A deploy or a move in flight: poll the site (which also heals a lost
  // worker) every 3 s until it settles, then stop — a page left open must not
  // keep polling. A failed poll does not end it (queries run with `retry:
  // false`): the last known state still says in flight. A 404/403 does —
  // the site is gone, or no longer ours to read.
  const gone = site.errorStatus === 404 || site.errorStatus === 403;
  const inFlight =
    !!s &&
    !gone &&
    (s.busy || !!s.movingTo || s.deploys.some((d) => isInFlight(d.status)));
  const reload = site.reload;
  const reloadOrdered = ordered.reload;
  const sorted = !!lq.sort;
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => {
      void reload();
      if (sorted) void reloadOrdered();
    }, 3000);
    return () => clearInterval(t);
  }, [inFlight, reload, reloadOrdered, sorted]);

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
    const body = sitePatch(edit.form);
    if (Object.keys(body).length === 0) {
      edit.close();
      return;
    }
    // The Save button is disabled for this; a poll can land between.
    if ("domain" in body && siteHeld(s)) return;
    setFieldErrs({});
    const r = await act.run(async () => {
      try {
        return await api.updateSite(id, body);
      } catch (err) {
        const inline = siteFieldErrors(err, body);
        if (Object.keys(inline).length === 0) throw err;
        setFieldErrs(inline);
        return undefined;
      }
    });
    if (!r) return;
    site.set({ ...s, ...r });
    edit.close();
    if (r.movingTo) notify.done(`Moving the site to ${r.movingTo}`);
    else notify.saved("site");
    // A rename is a deploy row of its own; a queued move is polled from here.
    if ("domain" in body)
      await Promise.all([
        site.reload(),
        lq.sort ? ordered.reload() : undefined,
      ]);
  };

  const crumbs = <Crumbs crumbs={s ?? {}} current={s?.name} />;
  if (site.error && (!s || gone))
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
  const primary = sitePrimaryUrl(s);
  const domainHeld = "domain" in sitePatch(edit.form) && siteHeld(s);
  const actions: HeaderAction[] = canWrite
    ? [
        {
          label: "Edit",
          onClick: () => {
            act.clear();
            setFieldErrs({});
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
          <>
            {s.currentDeploy ? (
              <Badge tone="ok">live</Badge>
            ) : (
              <Badge tone="neutral">nothing deployed</Badge>
            )}
            {s.movingTo && <Badge tone="warn">moving</Badge>}
          </>
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
      {site.error && (
        <Notice kind="error">
          Could not refresh the site: {site.error}
          {inFlight ? " Trying again in a few seconds." : ""}
        </Notice>
      )}
      <Section
        title="Public URL"
        description={
          s.domain ? (
            <>
              Named <Code>{s.domain}</Code>:{" "}
              {s.hostUrl
                ? "served on its own host and under the path host."
                : "the path is the name."}
            </>
          ) : s.domain === null ? (
            <>
              No name: the path is a random slug
              {canWrite ? " (Edit claims a name)" : ""}.
            </>
          ) : undefined
        }
      >
        {s.movingTo && (
          <Notice kind="info">
            Moving to <Code>{s.movingTo}</Code>: the files are being copied. The
            URLs below keep serving until the move completes, then stop working.
          </Notice>
        )}
        <Anchor href={primary} target="_blank" rel="noopener noreferrer">
          {primary}
        </Anchor>
        <CopyField label="URL" value={primary} />
        {siteOtherUrls(s).map((o) => (
          <CopyField key={o.label} label={o.label} value={o.url} />
        ))}
      </Section>
      {canWrite && (
        <DeploySection
          site={id}
          busy={s.busy}
          moving={!!s.movingTo}
          onDeployed={async () => {
            // The sorted list is its own key; refresh it beside the detail.
            await Promise.all([
              site.reload(),
              lq.sort ? ordered.reload() : undefined,
            ]);
          }}
        />
      )}
      <Section title="Deploys">
        <DataTable
          columns={[
            { key: "id", label: "Deploy id", sortKey: "id" },
            { key: "kind", label: "Kind" },
            { key: "status", label: "Status", sortKey: "status" },
            {
              key: "files",
              label: "Files",
              align: "right",
              sortKey: "files",
              defaultOrder: "desc",
            },
            {
              key: "size",
              label: "Size",
              align: "right",
              sortKey: "size",
              defaultOrder: "desc",
            },
            { key: "error", label: "Error" },
            {
              key: "created",
              label: "Created",
              sortKey: "createdAt",
              defaultOrder: "desc",
            },
          ]}
          rows={lq.sort ? (ordered.data ?? s.deploys) : s.deploys}
          fetching={!!lq.sort && (ordered.loading || ordered.fetching)}
          error={lq.sort ? ordered.error : undefined}
          sort={lq.sort}
          onSort={lq.setSort}
          rowKey={(d) => d.id}
          minWidth={640}
          empty={{ title: "No deploys yet." }}
          render={(d) => (
            <>
              <Table.Td>
                <Code>{d.id}</Code>
              </Table.Td>
              <Table.Td style={{ whiteSpace: "nowrap" }}>
                <DeployKind d={d} />
              </Table.Td>
              <Table.Td>
                <Badge tone={STATUS_TONE[d.status]}>{d.status}</Badge>
              </Table.Td>
              <Table.Td style={{ textAlign: "right" }}>{d.files}</Table.Td>
              <Table.Td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                {d.kind === "move" ? "—" : fmtSize(d.bytes)}
              </Table.Td>
              <Table.Td>{d.error ?? "—"}</Table.Td>
              <Table.Td style={{ whiteSpace: "nowrap" }}>
                {fmtTime(d.createdAt)}
              </Table.Td>
            </>
          )}
        />
      </Section>
      <BuildHints basePath={s.basePath} hostUrl={s.hostUrl} />
      <ResourceDrawer
        opened={edit.opened}
        onClose={edit.close}
        title="Edit site"
        submitLabel="Save"
        onSubmit={saveInfo}
        busy={act.busy}
        disabled={!edit.form.name.trim() || domainHeld}
        error={edit.opened ? act.error : null}
        danger={{
          label: "Delete site",
          description:
            "Every deploy and the site's URLs go with it. A name or path that has served files stays with this team.",
          onConfirm: remove,
          disabled: act.busy || s.busy,
        }}
      >
        <NameDescriptionFields
          name={edit.form.name}
          description={edit.form.description}
          onName={(name) => {
            edit.patch({ name });
            clearFieldErr("name");
          }}
          onDescription={(description) => {
            edit.patch({ description });
            clearFieldErr("description");
          }}
          nameError={fieldErrs.name}
          descriptionError={fieldErrs.description}
        />
        {s.domain !== undefined && (
          <DomainField
            site={s}
            value={edit.form.domain}
            onChange={(domain) => {
              edit.patch({ domain });
              clearFieldErr("domain");
            }}
            error={fieldErrs.domain ?? null}
          />
        )}
      </ResourceDrawer>
    </>
  );
}
