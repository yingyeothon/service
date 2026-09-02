import { Anchor, Group, Text, TextInput } from "@mantine/core";
import { IconHeart, IconHeartFilled } from "@tabler/icons-react";
import { type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { hasRole, useAuth } from "../auth";
import { Comments } from "../components/Comments";
import { Crumbs } from "../components/Crumbs";
import { PageSkeleton } from "../components/Loading";
import { Markdown } from "../components/Markdown";
import { MdField } from "../components/MdField";
import { PageHeader, type HeaderAction } from "../components/PageHeader";
import { ResourceDrawer, useDrawerForm } from "../components/ResourceDrawer";
import { ScreenshotField } from "../components/ScreenshotField";
import { Section } from "../components/Section";
import { Badge, Notice } from "../components/ui";
import { useConfirm } from "../lib/confirm";
import { fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { useAction, useApiQuery } from "../lib/query";

export function ShowEntryPage() {
  const { id = "", eid = "" } = useParams();
  const { me } = useAuth();
  const nav = useNavigate();
  const act = useAction();
  const confirm = useConfirm();
  const q = useApiQuery(["show-entry", id, eid, me?.id ?? null], () =>
    api.showEntry(id, eid),
  );
  const e = q.data;
  const edit = useDrawerForm(() => ({
    title: e?.title ?? "",
    bodyMd: e?.bodyMd ?? "",
    reason: "",
  }));
  const trail = [
    { label: "Shows", to: "/shows" },
    { label: "Show", to: `/shows/${id}` },
  ];

  if (q.error)
    return (
      <>
        <Crumbs trail={trail} />
        <PageHeader />
        <Notice kind="error">{q.error}</Notice>
      </>
    );
  if (!e)
    return (
      <>
        <Crumbs trail={trail} />
        <PageHeader />
        <PageSkeleton />
      </>
    );

  const mine = e.createdBy !== null && e.createdBy === me?.login;
  const admin = hasRole(me, "admin");
  /** An admin acting on content that is not theirs must say why. */
  const foreign = e.canModerate && !mine;

  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    const f = edit.form;
    const r = await act.run(() =>
      api.updateEntry(id, eid, { title: f.title.trim(), bodyMd: f.bodyMd }),
    );
    if (!r) return;
    edit.close();
    notify.saved("entry");
    await q.reload();
  };
  const remove = async () => {
    const r = await confirm({
      title: "Take it off the wall?",
      message: "The entry, its screenshots and its comments are removed.",
      confirmLabel: "Take it off the wall",
      danger: true,
      reason:
        admin && !mine
          ? { required: true, placeholder: "Why is this being removed?" }
          : undefined,
    });
    if (!r.ok) return;
    if (
      await act.run(() => api.deleteEntry(id, eid, r.reason).then(() => true))
    ) {
      notify.done("Entry taken off the wall");
      void nav(`/shows/${id}`);
    }
  };
  const like = async () => {
    await act.run(() =>
      e.liked ? api.unlikeEntry(id, eid) : api.likeEntry(id, eid),
    );
    await q.reload();
  };

  const actions: HeaderAction[] = [
    {
      label: `${e.likes}`,
      onClick: like,
      disabled: !e.canReact || act.busy,
      icon: e.liked ? (
        <IconHeartFilled size={16} aria-label="Liked" />
      ) : (
        <IconHeart size={16} aria-label="Like" />
      ),
    },
  ];
  if (e.canEdit) actions.push({ label: "Edit", onClick: edit.open });
  if (mine || e.canEdit || admin)
    actions.push({
      label: "Take it off the wall",
      danger: true,
      onClick: remove,
      disabled: act.busy,
    });

  return (
    <>
      <Crumbs trail={trail} current={e.title} />
      <PageHeader
        title={e.title}
        badges={
          <>
            <Badge tone="neutral">{e.target.kind}</Badge>
            {e.target.available && e.target.url ? (
              <Anchor href={e.target.url} target="_blank" rel="noreferrer">
                {e.target.name}
              </Anchor>
            ) : (
              <Text size="sm" c="dimmed">
                {e.target.name}
                {e.target.available ? "" : " · no longer available"}
              </Text>
            )}
            {e.target.ref && (
              <Text size="xs" c="dimmed">
                exhibiting {e.target.ref}
              </Text>
            )}
          </>
        }
        meta={
          <>
            {e.createdBy ?? "—"} · {fmtTime(e.createdAt)}
          </>
        }
        actions={actions}
      />
      {act.error && !edit.opened && <Notice kind="error">{act.error}</Notice>}
      {e.bodyMd && <Markdown text={e.bodyMd} />}

      <Section title="Screenshots">
        {e.canEdit ? (
          <ScreenshotField
            shots={e.shots}
            disabled={act.busy}
            onSave={async (keep, added) => {
              const ok = await act.run(() =>
                api
                  .setEntryScreenshots(
                    id,
                    eid,
                    added,
                    keep.map((k) => k.id),
                  )
                  // `useAction.run` gives back `undefined` on error, and a 204
                  // is `undefined` too — a sentinel is what tells them apart.
                  .then(() => true),
              );
              if (ok) notify.saved("screenshots");
              await q.reload();
              return ok;
            }}
          />
        ) : e.shots.length === 0 ? (
          <Text size="sm" c="dimmed">
            No screenshots.
          </Text>
        ) : (
          <Group gap="sm">
            {e.shots.map((s) => (
              <img
                key={s.id}
                src={s.url}
                alt=""
                loading="lazy"
                style={{ maxHeight: 240, maxWidth: "100%", borderRadius: 10 }}
              />
            ))}
          </Group>
        )}
      </Section>

      <Comments
        comments={e.comments}
        canPost={e.canReact}
        owner={e.canModerate}
        reasonOnForeignDelete={foreign}
        onAdd={async (b) => {
          await api.addEntryComment(id, eid, b);
          await q.reload();
        }}
        onEdit={async (cid, b) => {
          await api.editEntryComment(id, eid, cid, b);
          await q.reload();
        }}
        onDelete={async (cid, reason) => {
          await api.deleteEntryComment(id, eid, cid, reason);
          await q.reload();
        }}
      />

      <ResourceDrawer
        opened={edit.opened}
        onClose={edit.close}
        title="Edit entry"
        submitLabel="Save"
        onSubmit={save}
        busy={act.busy}
        disabled={
          !edit.form.title.trim() || (foreign && !edit.form.reason.trim())
        }
        error={edit.opened ? act.error : null}
        size="lg"
      >
        <TextInput
          label="Title"
          value={edit.form.title}
          onChange={(x) => edit.patch({ title: x.currentTarget.value })}
          required
          maxLength={200}
          autoComplete="off"
          data-autofocus
        />
        <MdField
          label="About it"
          value={edit.form.bodyMd}
          onChange={(bodyMd) => edit.patch({ bodyMd })}
        />
        {foreign && (
          <TextInput
            label="Why are you editing somebody else's entry?"
            value={edit.form.reason}
            onChange={(x) => edit.patch({ reason: x.currentTarget.value })}
            required
          />
        )}
      </ResourceDrawer>
    </>
  );
}
