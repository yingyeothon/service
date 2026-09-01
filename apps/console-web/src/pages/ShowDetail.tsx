import {
  Anchor,
  Button,
  Divider,
  Group,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { hasRole, useAuth } from "../auth";
import { EntryGrid } from "../components/EntryGrid";
import { Markdown } from "../components/Markdown";
import { MdField } from "../components/MdField";
import { TargetPicker, targetValue } from "../components/TargetPicker";
import {
  Badge,
  Confirm,
  ConfirmWithReason,
  Notice,
  Spinner,
} from "../components/ui";
import { fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";
import type { ShowEntry, ShowTargetKind } from "../types";

export function ShowDetailPage() {
  const { id = "" } = useParams();
  const { me } = useAuth();
  const nav = useNavigate();
  const act = useAction();
  const [sort, setSort] = useState<"new" | "likes">("new");
  const show = useApiQuery(["show", id, me?.id ?? null], () => api.show(id));
  // Cursor paging: the wall holds up to 200 entries and a page is 24, so
  // without this three quarters of a full show is unreachable.
  const [more, setMore] = useState<ShowEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const entries = useApiQuery(["show-entries", id, sort, me?.id ?? null], () =>
    api.showEntries(id, { sort }),
  );
  useEffect(() => {
    setMore([]);
    setNext(entries.data?.next ?? null);
  }, [entries.data]);
  const loadMore = async () => {
    if (!next) return;
    const page = await act.run(() =>
      api.showEntries(id, { sort, cursor: next }),
    );
    if (!page) return;
    setMore((prev) => [...prev, ...page.entries]);
    setNext(page.next);
  };
  const s = show.data;
  const canManage = s?.canManage ?? false;
  /**
   * An admin acting on a show that is not theirs must say why, on every
   * mutating call — not only the destructive ones (decision 12).
   */
  const foreign =
    canManage && s !== undefined && s.createdBy !== (me?.login ?? null);

  const [submitting, setSubmitting] = useState(false);
  const submittable = useApiQuery(
    ["show-submittable", id],
    () => api.showSubmittable(id),
    { enabled: submitting },
  );
  const [target, setTarget] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [bodyMd, setBodyMd] = useState("");
  const [grantLogin, setGrantLogin] = useState("");
  const [modReason, setModReason] = useState("");
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState("");

  const reload = async () => {
    await Promise.all([show.reload(), entries.reload()]);
  };

  const submit = async () => {
    if (!target || !title.trim()) return;
    const [kind, ...rest] = target.split(":");
    const r = await act.run(() =>
      api.submitEntry(id, {
        targetKind: kind as ShowTargetKind,
        targetId: rest.join(":"),
        title: title.trim(),
        bodyMd: bodyMd || undefined,
      }),
    );
    if (!r) return;
    setSubmitting(false);
    setTarget(null);
    setTitle("");
    setBodyMd("");
    await reload();
  };

  if (show.error) return <Notice kind="error">{show.error}</Notice>;
  if (!s) return <Spinner />;

  const closed = s.closedAt !== null;
  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <Stack gap={4}>
          <Title order={2}>{s.title}</Title>
          <Group gap="xs">
            <Badge tone={s.acl === "public" ? "ok" : "neutral"}>
              {s.acl === "public" ? "everyone may see this" : "members only"}
            </Badge>
            {closed && <Badge tone="neutral">closed</Badge>}
            <Text size="sm" c="dimmed">
              {s.createdBy ?? "—"} · {fmtTime(s.createdAt)} · {s.entryCount}{" "}
              {s.entryCount === 1 ? "entry" : "entries"}
            </Text>
          </Group>
          {s.eventId && (
            <Anchor component={Link} to={`/events/${s.eventId}`} size="sm">
              From the event page
            </Anchor>
          )}
        </Stack>
        <Group gap="xs">
          {s.canWrite && !closed && !submitting && (
            <Button onClick={() => setSubmitting(true)}>
              Put something up
            </Button>
          )}
          {canManage && (
            <Button
              variant="default"
              size="compact-sm"
              onClick={() => {
                setDraftBody(s.bodyMd);
                setEditing((v) => !v);
              }}
            >
              {editing ? "Stop editing" : "Edit page"}
            </Button>
          )}
          {canManage && (
            <Confirm
              label={closed ? "Reopen" : "Close"}
              color={closed ? "blue" : "orange"}
              confirmLabel={closed ? "Reopen it" : "Close it"}
              disabled={act.busy}
              onConfirm={async () => {
                const why = foreign ? modReason.trim() : undefined;
                await act.run(() =>
                  closed ? api.reopenShow(id, why) : api.closeShow(id, why),
                );
                await reload();
              }}
            />
          )}
          {hasRole(me, "admin") && (
            <ConfirmWithReason
              label="Delete show"
              confirmLabel="Delete it"
              required
              placeholder="Why is this being removed?"
              disabled={act.busy}
              onConfirm={async (reason) => {
                if (!reason) return;
                if (
                  await act.run(() =>
                    api.deleteShow(id, reason).then(() => true),
                  )
                )
                  void nav("/shows");
              }}
            />
          )}
        </Group>
      </Group>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {foreign && (
        <TextInput
          label="Why are you acting on somebody else's show?"
          description="Recorded with the action in the audit log."
          value={modReason}
          onChange={(e) => setModReason(e.currentTarget.value)}
        />
      )}
      {closed && (
        <Notice kind="info">
          This show is closed: it is read-only, and reopening it changes nothing
          about who may see it.
        </Notice>
      )}

      {editing && canManage ? (
        <Stack gap="xs">
          <MdField
            label="Page"
            value={draftBody}
            onChange={setDraftBody}
            minRows={6}
          />
          <Group gap="xs">
            <Button
              size="compact-sm"
              disabled={act.busy}
              onClick={() =>
                void (async () => {
                  await act.run(() =>
                    api.updateShow(id, { bodyMd: draftBody }),
                  );
                  setEditing(false);
                  await show.reload();
                })()
              }
            >
              Save page
            </Button>
            <SegmentedControl
              size="xs"
              value={s.acl}
              onChange={(v) =>
                void (async () => {
                  await act.run(() =>
                    api.updateShow(id, {
                      acl: v as typeof s.acl,
                      ...(foreign ? { reason: modReason.trim() } : {}),
                    }),
                  );
                  await show.reload();
                })()
              }
              data={[
                { value: "public", label: "Everyone" },
                { value: "member_only", label: "Members only" },
              ]}
            />
            <Text size="xs" c="dimmed">
              Opening a show to everyone is refused once it has entries: people
              submitted to the audience they were shown.
            </Text>
          </Group>
        </Stack>
      ) : (
        s.bodyMd && <Markdown text={s.bodyMd} />
      )}

      {canManage && (
        <Stack gap="xs">
          <Divider label="Who may put work up" labelPosition="left" />
          <Group gap="xs" align="flex-end">
            <TextInput
              size="xs"
              label="GitHub login"
              value={grantLogin}
              onChange={(e) => setGrantLogin(e.currentTarget.value)}
            />
            <Button
              size="compact-sm"
              disabled={act.busy || !grantLogin.trim()}
              onClick={() =>
                void (async () => {
                  await act.run(() => api.grantShow(id, grantLogin.trim()));
                  setGrantLogin("");
                  await show.reload();
                })()
              }
            >
              Grant
            </Button>
          </Group>
          <Group gap="xs">
            {(s.grants ?? []).length === 0 ? (
              <Text size="sm" c="dimmed">
                Only you (and platform admins) may submit.
              </Text>
            ) : (
              (s.grants ?? []).map((g) => (
                <Group key={g.login ?? `?${String(g.grantedAt)}`} gap={4}>
                  <Text size="sm">{g.login}</Text>
                  <Confirm
                    label="Revoke"
                    disabled={act.busy}
                    onConfirm={async () => {
                      if (g.login)
                        await act.run(() => api.revokeShow(id, g.login!));
                      await show.reload();
                    }}
                  />
                </Group>
              ))
            )}
          </Group>
        </Stack>
      )}

      {submitting && (
        <Stack gap="xs">
          <Divider label="Put something up" labelPosition="left" />
          {submittable.error && (
            <Notice kind="error">{submittable.error}</Notice>
          )}
          <TargetPicker
            targets={submittable.data ?? []}
            value={target}
            disabled={act.busy}
            onChange={(v) => {
              setTarget(v);
              const picked = (submittable.data ?? []).find(
                (t) => targetValue(t.kind, t.id) === v,
              );
              if (picked && !title) setTitle(picked.name);
            }}
          />
          <TextInput
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
          />
          <MdField label="About it" value={bodyMd} onChange={setBodyMd} />
          <Text size="xs" c="dimmed">
            Submitting is publication: the name and the link of what you pick
            become visible to everyone who can see this show.
          </Text>
          <Group gap="xs">
            <Button
              size="compact-sm"
              disabled={act.busy || !target || !title.trim()}
              onClick={() => void submit()}
            >
              Submit
            </Button>
            <Button
              size="compact-sm"
              variant="default"
              onClick={() => setSubmitting(false)}
            >
              Cancel
            </Button>
          </Group>
        </Stack>
      )}

      <Divider label="On the wall" labelPosition="left" />
      {entries.error && <Notice kind="error">{entries.error}</Notice>}
      <EntryGrid
        entries={[...(entries.data?.entries ?? []), ...more]}
        sort={sort}
        onSort={setSort}
        loading={entries.loading && !entries.data}
        onMore={next ? () => void loadMore() : undefined}
      />
    </Stack>
  );
}
