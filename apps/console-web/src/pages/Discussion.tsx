import { Button, Card, Group, Text, Title } from "@mantine/core";
import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { Comments } from "../components/Comments";
import { Crumbs } from "../components/Crumbs";
import { Markdown } from "../components/Markdown";
import { Confirm, Notice, Spinner } from "../components/ui";
import { DraftForm } from "../components/ResourceForms";
import { fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";
import { teamUrl, useTeamStanding } from "../lib/team";

export function DiscussionPage() {
  const { team: teamId = "", id = "" } = useParams();
  const nav = useNavigate();
  const t = useTeamStanding(teamId);
  const d = useApiQuery(["discussion", teamId, id], () =>
    api.discussion(teamId, id),
  );
  const act = useAction();
  const [draft, setDraft] = useState<{ title: string; bodyMd: string } | null>(
    null,
  );

  if (d.error) return <Notice kind="error">{d.error}</Notice>;
  if (!d.data) return <Spinner />;
  const disc = d.data;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const r = await act.run(() =>
      api.updateDiscussion(teamId, id, {
        title: draft.title.trim(),
        bodyMd: draft.bodyMd,
      }),
    );
    if (r) {
      d.set({ ...disc, ...r });
      setDraft(null);
    }
  };
  const remove = async () => {
    const ok = await act.run(async () => {
      await api.deleteDiscussion(teamId, id);
      return true;
    });
    if (ok) void nav(teamUrl(teamId, "discussions"));
  };

  return (
    <>
      <Crumbs
        crumbs={{ teamId, teamName: t.team?.name ?? null }}
        current="Discussion"
      />
      <Title order={2} mb="xs">
        {disc.title}
      </Title>
      <Text size="xs" c="dimmed" mb="sm">
        {disc.createdBy ?? "—"} · {fmtTime(disc.createdAt)}
        {disc.updatedAt !== disc.createdAt &&
          ` · edited ${fmtTime(disc.updatedAt)}`}
      </Text>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {draft ? (
        <DraftForm
          draft={draft}
          onChange={setDraft}
          onSubmit={save}
          onCancel={() => setDraft(null)}
          submitLabel="Save"
          bodyLabel="Body"
          busy={act.busy}
        />
      ) : (
        <Card withBorder mb="md" padding="sm">
          <Markdown text={disc.bodyMd} />
          {disc.bodyMd.trim() === "" && (
            <Text size="sm" c="dimmed">
              No body.
            </Text>
          )}
          <Group gap="xs" mt="xs">
            {disc.mine && t.canWrite && (
              <Button
                size="compact-sm"
                variant="default"
                onClick={() =>
                  setDraft({ title: disc.title, bodyMd: disc.bodyMd })
                }
              >
                Edit
              </Button>
            )}
            {(disc.mine || t.owner) && (
              <Confirm label="Delete" onConfirm={remove} disabled={act.busy} />
            )}
          </Group>
        </Card>
      )}
      <Comments
        comments={disc.comments}
        canPost={t.canWrite}
        owner={t.owner}
        onAdd={async (bodyMd) => {
          await api.addDiscussionComment(teamId, id, bodyMd);
          await d.reload();
        }}
        onEdit={async (cid, bodyMd) => {
          await api.updateDiscussionComment(teamId, id, cid, bodyMd);
          await d.reload();
        }}
        onDelete={async (cid) => {
          await api.deleteDiscussionComment(teamId, id, cid);
          await d.reload();
        }}
      />
    </>
  );
}
