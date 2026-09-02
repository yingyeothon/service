import { Box, NativeSelect, Text } from "@mantine/core";
import { type FormEvent } from "react";
import { useParams } from "react-router";
import { api } from "../api";
import { Comments } from "../components/Comments";
import { Crumbs } from "../components/Crumbs";
import { PageSkeleton } from "../components/Loading";
import { Markdown } from "../components/Markdown";
import { PageHeader, type HeaderAction } from "../components/PageHeader";
import { ResourceDrawer, useDrawerForm } from "../components/ResourceDrawer";
import { Badge, Notice } from "../components/ui";
import { useConfirm } from "../lib/confirm";
import { fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { useAction, useApiQuery } from "../lib/query";
import { useTeamStanding } from "../lib/team";
import type { Version } from "../types";
import { DiscussionFields } from "./Team";

export const ISSUE_TONE = { open: "ok", closed: "neutral" } as const;

/** Version picker shared by the issue form and the issue page. */
export function VersionSelect({
  versions,
  value,
  onChange,
  label = "Version",
}: {
  versions: Version[];
  value: string | null;
  onChange: (v: string | null) => void;
  label?: string;
}) {
  return (
    <NativeSelect
      label={label}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      data={[
        { value: "", label: "— none —" },
        ...versions.map((v) => ({ value: v.id, label: v.name })),
      ]}
    />
  );
}

export function IssuePage() {
  const { team: teamId = "", prj = "", n: nRaw = "" } = useParams();
  const n = Number(nRaw);
  const t = useTeamStanding(teamId);
  const project = useApiQuery(["project", prj], () => api.project(prj));
  const issue = useApiQuery(["issue", prj, n], () => api.issue(prj, n));
  const versions = useApiQuery(["versions", prj], () => api.versions(prj));
  const act = useAction();
  const confirm = useConfirm();
  const i = issue.data;
  const edit = useDrawerForm(() => ({
    title: i?.title ?? "",
    bodyMd: i?.bodyMd ?? "",
    versionId: i?.versionId ?? null,
  }));
  const crumbs = (
    <Crumbs
      crumbs={{
        teamId,
        teamName: project.data?.teamName ?? t.team?.name ?? null,
        projectId: prj,
        projectName: project.data?.name ?? null,
      }}
      current={i ? `#${i.number}` : undefined}
    />
  );

  if (issue.error)
    return (
      <>
        {crumbs}
        <PageHeader />
        <Notice kind="error">{issue.error}</Notice>
      </>
    );
  if (!i)
    return (
      <>
        {crumbs}
        <PageHeader />
        <PageSkeleton />
      </>
    );
  const versionName = (id: string | null) =>
    id ? (versions.data?.find((v) => v.id === id)?.name ?? id) : null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() =>
      api.updateIssue(prj, n, {
        title: edit.form.title.trim(),
        bodyMd: edit.form.bodyMd,
        versionId: edit.form.versionId,
      }),
    );
    if (!r) return;
    issue.set({ ...i, ...r });
    edit.close();
    notify.saved("issue");
  };
  const toggle = async () => {
    const closing = i.status === "open";
    const ok = await confirm({
      title: closing ? `Close #${i.number}?` : `Reopen #${i.number}?`,
      confirmLabel: closing ? "Close issue" : "Reopen issue",
    });
    if (!ok.ok) return;
    const r = await act.run(() =>
      api.setIssueStatus(prj, n, closing ? "close" : "reopen"),
    );
    if (r) {
      issue.set({ ...i, ...r });
      notify.done(closing ? "Issue closed" : "Issue reopened");
    }
  };

  const actions: HeaderAction[] = t.canWrite
    ? [
        {
          label: "Edit",
          onClick: () => {
            act.clear();
            edit.open();
          },
        },
        {
          label: i.status === "open" ? "Close issue" : "Reopen issue",
          menu: true,
          onClick: toggle,
          disabled: act.busy,
        },
      ]
    : [];

  return (
    <>
      {crumbs}
      <PageHeader
        title={`#${i.number} ${i.title}`}
        badges={<Badge tone={ISSUE_TONE[i.status]}>{i.status}</Badge>}
        meta={
          <>
            {i.createdBy ?? "—"} · opened {fmtTime(i.createdAt)}
            {i.closedAt !== null && ` · closed ${fmtTime(i.closedAt)}`}
            {i.versionId && (
              <>
                {" "}
                · version <strong>{versionName(i.versionId)}</strong>
              </>
            )}
          </>
        }
        actions={actions}
      />
      {act.error && !edit.opened && <Notice kind="error">{act.error}</Notice>}
      <Box mb="xl">
        <Markdown text={i.bodyMd} />
        {i.bodyMd.trim() === "" && (
          <Text size="sm" c="dimmed">
            No description.
          </Text>
        )}
      </Box>
      <Comments
        comments={i.comments}
        canPost={t.canWrite}
        owner={t.owner}
        onAdd={async (bodyMd) => {
          await api.addIssueComment(prj, n, bodyMd);
          await issue.reload();
        }}
        onEdit={async (cid, bodyMd) => {
          await api.updateIssueComment(prj, n, cid, bodyMd);
          await issue.reload();
        }}
        onDelete={async (cid) => {
          await api.deleteIssueComment(prj, n, cid);
          await issue.reload();
        }}
      />
      <ResourceDrawer
        opened={edit.opened}
        onClose={edit.close}
        title="Edit issue"
        submitLabel="Save"
        onSubmit={save}
        busy={act.busy}
        disabled={!edit.form.title.trim()}
        error={edit.opened ? act.error : null}
        size="lg"
      >
        <DiscussionFields
          title={edit.form.title}
          bodyMd={edit.form.bodyMd}
          onChange={(p) => edit.patch(p)}
          bodyLabel="Description"
          extra={
            <VersionSelect
              versions={versions.data ?? []}
              value={edit.form.versionId}
              onChange={(versionId) => edit.patch({ versionId })}
            />
          }
        />
      </ResourceDrawer>
    </>
  );
}
