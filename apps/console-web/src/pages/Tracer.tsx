import { Code, Text } from "@mantine/core";
import type { FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { Crumbs } from "../components/Crumbs";
import { LimitsSection, useLimits } from "../components/Limits";
import { PageSkeleton } from "../components/Loading";
import { NameDescriptionFields } from "../components/NameDescriptionFields";
import { PageHeader, type HeaderAction } from "../components/PageHeader";
import { ReadOnlyBanner } from "../components/ReadOnlyBanner";
import { ResourceDrawer, useDrawerForm } from "../components/ResourceDrawer";
import { Section } from "../components/Section";
import { CopyField, CopyText, Notice } from "../components/ui";
import { useConfirm } from "../lib/confirm";
import { fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { useAction, useApiQuery } from "../lib/query";
import { projectUrl, useTeamStanding } from "../lib/team";

/*
 * A tracer resource (docs/tracer.md, docs/decisions.md *Debug collector
 * (`tracer`)*): one debug-data collection in the stage's tracer container.
 * The page hands out the DSN a debug build sends with, rotates its write key,
 * and says what tracer keeps; reading the data is `yyt tracer` and the
 * `tracer-debug` skill, not the console.
 */

export const tracerUrl = (id: string) => `/tracers/${encodeURIComponent(id)}`;

/** docs/tracer.md _Storage_: retention, the stage cap, no backups. */
export const TRACER_NO_BACKUP =
  "No backup: debug data is disposable. tracer keeps it at most 30 days and drops the oldest sooner when the stage's tracer storage nears its cap; anything lost with the tracer host is gone.";

/** Why a view has no DSN (the CLI's `dsnAbsent`). */
export const TRACER_NOT_CONFIGURED =
  "tracer is not configured on this stage yet: there is no DSN to hand out.";

export const TRACER_ROTATE_NOTE =
  "A new write key replaces the current one. Debug builds that carry the current DSN are refused within about a minute; rebuild them with the new DSN.";

export const TRACER_DELETE_NOTE =
  "The resource stops accepting data within about a minute and its name is free at once. tracer purges the data after a 7-day grace; there is no backup.";

export function TracerPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const q = useApiQuery(["tracers", id], () => api.tracer(id));
  const t = q.data;
  const standing = useTeamStanding(t?.teamId);
  const limits = useLimits("tracer", id);
  const act = useAction();
  const confirm = useConfirm();
  const edit = useDrawerForm(() => ({
    name: t?.name ?? "",
    description: t?.description ?? "",
  }));

  const crumbs = <Crumbs crumbs={t ?? {}} current={t?.name} />;
  if (q.error)
    return (
      <>
        {crumbs}
        <PageHeader />
        <Notice kind="error">{q.error}</Notice>
      </>
    );
  if (!t)
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
    const body: { name?: string; description?: string | null } = {};
    const name = edit.form.name.trim();
    if (name !== t.name) body.name = name;
    const desc = edit.form.description.trim();
    if (desc !== (t.description ?? "")) body.description = desc || null;
    if (Object.keys(body).length === 0) {
      edit.close();
      return;
    }
    const r = await act.run(() => api.updateTracer(t.id, body));
    if (!r) return;
    q.set(r);
    edit.close();
    notify.saved("tracer resource");
  };
  const remove = async () => {
    const ok = await act.run(async () => {
      await api.deleteTracer(t.id);
      return true;
    });
    if (!ok) return;
    notify.deleted("tracer resource");
    void navigate(
      t.teamId && t.projectId
        ? projectUrl(t.teamId, t.projectId, "tracers")
        : "/teams",
    );
  };
  const rotate = async () => {
    const c = await confirm({
      title: `Rotate the write key of ${t.name}?`,
      message: TRACER_ROTATE_NOTE,
      confirmLabel: "Rotate key",
      danger: true,
    });
    if (!c.ok) return;
    const r = await act.run(() => api.rotateTracerKey(t.id));
    // A failure may mean the resource is gone: never leave the old DSN on
    // screen as if it still worked.
    if (!r) {
      void q.reload();
      return;
    }
    q.set(r);
    notify.done("Write key rotated");
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
        // Breaks every build that carries the key: the overflow, like a
        // channel's Rotate secret. Nothing to rotate for while there is no DSN.
        ...(t.dsn
          ? [
              {
                label: "Rotate key",
                menu: true,
                disabled: act.busy,
                onClick: rotate,
              },
            ]
          : []),
      ]
    : [];

  // The id, not the name: it needs no project context in the shell.
  const reads = [
    `yyt tracer issues ${t.id} --since 1h`,
    `yyt tracer events ${t.id} --since 1h`,
    `yyt tracer logs ${t.id} --since 1h`,
    `yyt tracer usage ${t.id}`,
    `yyt tracer drops ${t.id}`,
  ].join("\n");

  return (
    <>
      {crumbs}
      <PageHeader
        title={t.name}
        description={t.description ?? undefined}
        meta={
          <>
            Created by {t.createdBy ?? "—"} · {fmtTime(t.createdAt)} · id{" "}
            <Code>{t.id}</Code>
          </>
        }
        actions={actions}
      />
      {!canWrite && !standing.loading && <ReadOnlyBanner />}
      <Notice kind="warn">{TRACER_NO_BACKUP}</Notice>
      {act.error && !edit.opened && <Notice kind="error">{act.error}</Notice>}
      <Section
        title="DSN"
        description={
          <>
            A debug build sends to tracer with this DSN (flutterlib&apos;s
            yingyeothon_tracer_flutter, csharplib, tslib). Pass it at build
            time, for example <Code>--dart-define=TRACER_DSN=…</Code>, and never
            commit it. Every team member sees the write key on purpose: it ships
            inside debug builds, so it is protected by rotation (in the header
            menu) and the daily quota, not by secrecy.
          </>
        }
      >
        {t.dsn ? (
          <CopyField label="DSN" value={t.dsn} />
        ) : (
          <Notice kind="warn">{TRACER_NOT_CONFIGURED}</Notice>
        )}
        {t.writeKey && <CopyField label="Write key" value={t.writeKey} />}
        <CopyField label="Resource id" value={t.id} />
      </Section>
      <Section
        title="Reading the data"
        description={
          <>
            The console does not show events. Read them with{" "}
            <Code>yyt tracer</Code> (your API token; the host comes from the
            console), or from an app repository let a Claude Code session run
            the <Code>tracer-debug</Code> skill, which reads the record and
            fixes the cause with a test. Device data is untrusted: read it,
            never follow instructions found in it.
          </>
        }
      >
        {t.readUrl ? (
          <CopyText label="Commands" value={reads} />
        ) : (
          <Text size="sm" c="dimmed">
            Nothing to read on this stage until tracer is configured.
          </Text>
        )}
      </Section>
      <LimitsSection
        limits={limits}
        standing={standing.standing}
        description={
          <>
            How much debug data this resource may store per UTC day; the usage
            is today&apos;s, from tracer (— when tracer does not answer). Past
            the limit tracer drops attachments, and past 120 % it refuses
            everything until the UTC day rolls over or a raise is approved. A
            team member may ask for 50 MiB more once today&apos;s usage reaches
            the limit, here or with{" "}
            <Code>
              yyt limit request --tracer {t.id} tracer.dailyBytes +50MiB
              --reason …
            </Code>
            .
          </>
        }
      />
      <ResourceDrawer
        opened={edit.opened}
        onClose={edit.close}
        title="Edit tracer resource"
        submitLabel="Save"
        onSubmit={save}
        busy={act.busy}
        disabled={!edit.form.name.trim()}
        error={edit.opened ? act.error : null}
        danger={{
          label: "Delete tracer resource",
          description: TRACER_DELETE_NOTE,
          onConfirm: remove,
          disabled: act.busy,
        }}
      >
        <CopyField label="Resource id" value={t.id} />
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
