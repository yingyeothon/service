import {
  Button,
  Card,
  Group,
  NativeSelect,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { api } from "../api";
import { Comments } from "../components/Comments";
import { Crumbs } from "../components/Crumbs";
import { Markdown } from "../components/Markdown";
import { MdField } from "../components/MdField";
import { Badge, Confirm, Notice, Spinner } from "../components/ui";
import { fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";
import { useTeamStanding } from "../lib/team";
import type { Version } from "../types";

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
  const [draft, setDraft] = useState<{
    title: string;
    bodyMd: string;
    versionId: string | null;
  } | null>(null);

  if (issue.error) return <Notice kind="error">{issue.error}</Notice>;
  if (!issue.data) return <Spinner />;
  const i = issue.data;
  const versionName = (id: string | null) =>
    id ? (versions.data?.find((v) => v.id === id)?.name ?? id) : null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const r = await act.run(() =>
      api.updateIssue(prj, n, {
        title: draft.title.trim(),
        bodyMd: draft.bodyMd,
        versionId: draft.versionId,
      }),
    );
    if (r) {
      issue.set({ ...i, ...r });
      setDraft(null);
    }
  };
  const toggle = async () => {
    const r = await act.run(() =>
      api.setIssueStatus(prj, n, i.status === "open" ? "close" : "reopen"),
    );
    if (r) issue.set({ ...i, ...r });
  };

  return (
    <>
      <Crumbs
        crumbs={{
          teamId,
          teamName: project.data?.teamName ?? t.team?.name ?? null,
          projectId: prj,
          projectName: project.data?.name ?? null,
        }}
        current={`Issue #${i.number}`}
      />
      <Group gap="xs" mb="xs" align="center">
        <Title order={2}>
          #{i.number} {i.title}
        </Title>
        <Badge tone={ISSUE_TONE[i.status]}>{i.status}</Badge>
      </Group>
      <Text size="xs" c="dimmed" mb="sm">
        {i.createdBy ?? "—"} · opened {fmtTime(i.createdAt)}
        {i.closedAt !== null && ` · closed ${fmtTime(i.closedAt)}`}
        {i.versionId && (
          <>
            {" "}
            · version <strong>{versionName(i.versionId)}</strong>
          </>
        )}
      </Text>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {draft ? (
        <Card withBorder mb="md" padding="sm">
          <form onSubmit={(e) => void save(e)}>
            <Stack gap="xs">
              <TextInput
                label="Title"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                required
                maxLength={200}
              />
              <VersionSelect
                versions={versions.data ?? []}
                value={draft.versionId}
                onChange={(versionId) => setDraft({ ...draft, versionId })}
              />
              <MdField
                label="Body"
                value={draft.bodyMd}
                onChange={(bodyMd) => setDraft({ ...draft, bodyMd })}
              />
              <Group>
                <Button
                  type="submit"
                  disabled={act.busy || !draft.title.trim()}
                >
                  Save
                </Button>
                <Button variant="default" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
              </Group>
            </Stack>
          </form>
        </Card>
      ) : (
        <Card withBorder mb="md" padding="sm">
          <Markdown text={i.bodyMd} />
          {i.bodyMd.trim() === "" && (
            <Text size="sm" c="dimmed">
              No description.
            </Text>
          )}
          {t.canWrite && (
            <Group gap="xs" mt="xs">
              <Button
                size="compact-sm"
                variant="default"
                onClick={() =>
                  setDraft({
                    title: i.title,
                    bodyMd: i.bodyMd,
                    versionId: i.versionId,
                  })
                }
              >
                Edit
              </Button>
              <Confirm
                label={i.status === "open" ? "Close issue" : "Reopen issue"}
                confirmLabel={i.status === "open" ? "Close" : "Reopen"}
                color="brand"
                variant="default"
                onConfirm={toggle}
                disabled={act.busy}
              />
            </Group>
          )}
        </Card>
      )}
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
    </>
  );
}
