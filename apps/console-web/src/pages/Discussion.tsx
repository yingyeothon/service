import { Box, Text } from "@mantine/core";
import { type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { Comments } from "../components/Comments";
import { Crumbs } from "../components/Crumbs";
import { PageSkeleton } from "../components/Loading";
import { Markdown } from "../components/Markdown";
import { PageHeader, type HeaderAction } from "../components/PageHeader";
import { ResourceDrawer, useDrawerForm } from "../components/ResourceDrawer";
import { Notice } from "../components/ui";
import { useConfirm } from "../lib/confirm";
import { fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { useAction, useApiQuery } from "../lib/query";
import { teamUrl, useTeamStanding } from "../lib/team";
import { DiscussionFields } from "./Team";

export function DiscussionPage() {
  const { team: teamId = "", id = "" } = useParams();
  const nav = useNavigate();
  const t = useTeamStanding(teamId);
  const d = useApiQuery(["discussion", teamId, id], () =>
    api.discussion(teamId, id),
  );
  const act = useAction();
  const confirm = useConfirm();
  const disc = d.data;
  const edit = useDrawerForm(() => ({
    title: disc?.title ?? "",
    bodyMd: disc?.bodyMd ?? "",
  }));
  const crumbs = (
    <Crumbs
      crumbs={{ teamId, teamName: t.team?.name ?? null }}
      current={disc?.title}
    />
  );

  if (d.error)
    return (
      <>
        {crumbs}
        <PageHeader />
        <Notice kind="error">{d.error}</Notice>
      </>
    );
  if (!disc)
    return (
      <>
        {crumbs}
        <PageHeader />
        <PageSkeleton />
      </>
    );

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() =>
      api.updateDiscussion(teamId, id, {
        title: edit.form.title.trim(),
        bodyMd: edit.form.bodyMd,
      }),
    );
    if (!r) return;
    d.set({ ...disc, ...r });
    edit.close();
    notify.saved("discussion");
  };
  const remove = async () => {
    const ok = await act.run(async () => {
      await api.deleteDiscussion(teamId, id);
      return true;
    });
    if (!ok) return;
    notify.deleted("discussion");
    void nav(teamUrl(teamId, "discussions"));
  };

  const canEdit = disc.mine && t.canWrite;
  const canDelete = disc.mine || t.owner;
  const actions: HeaderAction[] = [];
  if (canEdit)
    actions.push({
      label: "Edit",
      onClick: () => {
        act.clear();
        edit.open();
      },
    });
  // An owner who is not the author cannot edit, so the danger zone of the
  // edit drawer is out of reach: give them the verb in the overflow menu.
  if (canDelete && !canEdit)
    actions.push({
      label: "Delete discussion",
      danger: true,
      onClick: async () => {
        const r = await confirm({
          title: "Delete discussion?",
          message: "Its comments go with it.",
          confirmLabel: "Delete discussion",
          danger: true,
        });
        if (r.ok) await remove();
      },
    });

  return (
    <>
      {crumbs}
      <PageHeader
        title={disc.title}
        meta={
          <>
            {disc.createdBy ?? "—"} · {fmtTime(disc.createdAt)}
            {disc.updatedAt !== disc.createdAt &&
              ` · edited ${fmtTime(disc.updatedAt)}`}
          </>
        }
        actions={actions}
      />
      {act.error && !edit.opened && <Notice kind="error">{act.error}</Notice>}
      <Box mb="xl">
        <Markdown text={disc.bodyMd} />
        {disc.bodyMd.trim() === "" && (
          <Text size="sm" c="dimmed">
            No body.
          </Text>
        )}
      </Box>
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
      <ResourceDrawer
        opened={edit.opened}
        onClose={edit.close}
        title="Edit discussion"
        submitLabel="Save"
        onSubmit={save}
        busy={act.busy}
        disabled={!edit.form.title.trim()}
        error={edit.opened ? act.error : null}
        size="lg"
        danger={
          canDelete
            ? {
                label: "Delete discussion",
                description: "Its comments go with it.",
                onConfirm: remove,
                disabled: act.busy,
              }
            : undefined
        }
      >
        <DiscussionFields
          title={edit.form.title}
          bodyMd={edit.form.bodyMd}
          onChange={(p) => edit.patch(p)}
        />
      </ResourceDrawer>
    </>
  );
}
