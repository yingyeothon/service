import {
  Anchor,
  Button,
  Divider,
  Group,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconHeart, IconHeartFilled } from "@tabler/icons-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { hasRole, useAuth } from "../auth";
import { Comments } from "../components/Comments";
import { Markdown } from "../components/Markdown";
import { MdField } from "../components/MdField";
import { ScreenshotField } from "../components/ScreenshotField";
import { Badge, ConfirmWithReason, Notice, Spinner } from "../components/ui";
import { fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";

export function ShowEntryPage() {
  const { id = "", eid = "" } = useParams();
  const { me } = useAuth();
  const nav = useNavigate();
  const act = useAction();
  const q = useApiQuery(["show-entry", id, eid, me?.id ?? null], () =>
    api.showEntry(id, eid),
  );
  const e = q.data;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [bodyMd, setBodyMd] = useState("");
  const [modReason, setModReason] = useState("");

  if (q.error) return <Notice kind="error">{q.error}</Notice>;
  if (!e) return <Spinner />;

  const mine = e.createdBy !== null && e.createdBy === me?.login;
  const admin = hasRole(me, "admin");
  /** An admin acting on content that is not theirs must say why. */
  const foreign = e.canModerate && !mine;
  return (
    <Stack gap="md">
      <Anchor component={Link} to={`/shows/${id}`} size="sm">
        ← back to the show
      </Anchor>
      <Group justify="space-between" align="flex-start">
        <Stack gap={4}>
          <Title order={2}>{e.title}</Title>
          <Group gap="xs">
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
          </Group>
          <Text size="sm" c="dimmed">
            {e.createdBy ?? "—"} · {fmtTime(e.createdAt)}
          </Text>
        </Stack>
        <Group gap="xs">
          <Button
            size="compact-sm"
            variant={e.liked ? "filled" : "light"}
            disabled={!e.canReact || act.busy}
            leftSection={
              e.liked ? <IconHeartFilled size={14} /> : <IconHeart size={14} />
            }
            onClick={() =>
              void (async () => {
                await act.run(() =>
                  e.liked ? api.unlikeEntry(id, eid) : api.likeEntry(id, eid),
                );
                await q.reload();
              })()
            }
          >
            {e.likes}
          </Button>
          {e.canEdit && (
            <Button
              size="compact-sm"
              variant="default"
              onClick={() => {
                setTitle(e.title);
                setBodyMd(e.bodyMd);
                setEditing((v) => !v);
              }}
            >
              {editing ? "Stop editing" : "Edit"}
            </Button>
          )}
          {(mine || e.canEdit || admin) && (
            <ConfirmWithReason
              label="Take it off the wall"
              confirmLabel="Remove it"
              required={admin && !mine}
              placeholder="Why is this being removed?"
              disabled={act.busy}
              onConfirm={async (reason) => {
                if (
                  await act.run(() =>
                    api.deleteEntry(id, eid, reason).then(() => true),
                  )
                )
                  void nav(`/shows/${id}`);
              }}
            />
          )}
        </Group>
      </Group>
      {act.error && <Notice kind="error">{act.error}</Notice>}

      {editing ? (
        <Stack gap="xs">
          <TextInput
            label="Title"
            value={title}
            onChange={(x) => setTitle(x.currentTarget.value)}
          />
          <MdField label="About it" value={bodyMd} onChange={setBodyMd} />
          {foreign && (
            <TextInput
              label="Why are you editing somebody else's entry?"
              value={modReason}
              onChange={(x) => setModReason(x.currentTarget.value)}
            />
          )}
          <Group gap="xs">
            <Button
              size="compact-sm"
              disabled={
                act.busy || !title.trim() || (foreign && !modReason.trim())
              }
              onClick={() =>
                void (async () => {
                  await act.run(() =>
                    api.updateEntry(id, eid, { title: title.trim(), bodyMd }),
                  );
                  setEditing(false);
                  await q.reload();
                })()
              }
            >
              Save
            </Button>
          </Group>
        </Stack>
      ) : (
        e.bodyMd && <Markdown text={e.bodyMd} />
      )}

      <Divider label="Screenshots" labelPosition="left" />
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
            await q.reload();
            return ok;
          }}
        />
      ) : e.shots.length === 0 ? (
        <Text size="sm" c="dimmed">
          No screenshots.
        </Text>
      ) : (
        <Group gap="xs">
          {e.shots.map((s) => (
            <img
              key={s.id}
              src={s.url}
              alt=""
              style={{ maxHeight: 240, borderRadius: 4 }}
            />
          ))}
        </Group>
      )}

      <Divider label="Comments" labelPosition="left" />
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
    </Stack>
  );
}
