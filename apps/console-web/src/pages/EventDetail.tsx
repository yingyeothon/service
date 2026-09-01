import {
  Anchor,
  Button,
  Card,
  Checkbox,
  Code,
  Group,
  Image,
  Select,
  Stack,
  Stepper,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useRef, useState, type ChangeEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { hasRole, useAuth } from "../auth";
import { Comments } from "../components/Comments";
import { EventForm } from "../components/EventForm";
import { EntryGrid } from "../components/EntryGrid";
import { Markdown } from "../components/Markdown";
import { Badge, Confirm, Notice, Spinner } from "../components/ui";
import { diffLines, revisionText } from "../lib/diff";
import { formFromEvent } from "../lib/eventForm";
import { fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";
import {
  EVENT_STATUSES,
  type EventDetail,
  type EventInput,
  type EventRevision,
  type EventStatus,
} from "../types";
import { STATUS_TONE } from "./Events";

const EDITABLE: readonly EventStatus[] = [
  "draft",
  "voting",
  "waiting",
  "opened",
];

export function EventDetailPage() {
  const { id = "" } = useParams();
  const { me, loading: authLoading } = useAuth();
  const nav = useNavigate();
  // Wait for /me: an anonymous fetch of an in-progress event would 404 and flash an error.
  const ev = useApiQuery(["event", id, me?.id ?? null], () => api.event(id), {
    enabled: !authLoading,
  });
  const act = useAction();
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);

  if (ev.error) return <Notice kind="error">{ev.error}</Notice>;
  if (!ev.data) return <Spinner />;
  const e = ev.data;
  const member = hasRole(me, "member");
  const editable = e.canEdit && EDITABLE.includes(e.status);

  const save = async (input: EventInput | Partial<EventInput>) => {
    const r = await act.run(() => api.updateEvent(e.id, input));
    if (r) {
      setEditing(false);
      ev.set(r);
    }
  };

  return (
    <>
      <Text size="sm" mb="xs">
        <Anchor component={Link} to="/events">
          ← Events
        </Anchor>
      </Text>
      <Group gap="xs" mb="xs">
        <Title order={2}>{e.title}</Title>
        <Badge tone={STATUS_TONE[e.status]}>{e.status}</Badge>
      </Group>
      <When e={e} />
      {e.status !== "cancelled" && <StatusSteps status={e.status} />}
      {e.status === "cancelled" && (
        <Notice kind="error">
          Cancelled {fmtTime(e.cancelledAt)} by {e.cancelledBy ?? "—"}.
        </Notice>
      )}
      {act.error && <Notice kind="error">{act.error}</Notice>}

      {editing ? (
        <EventForm
          initial={formFromEvent(e)}
          schedule={e.status === "draft"}
          busy={act.busy}
          submitLabel="Save"
          onSubmit={save}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          {e.posterUrl && (
            <Image
              src={`${api.posterSrc(e.id)}?v=${e.revision}`}
              alt={`${e.title} poster`}
              maw={420}
              radius="sm"
              mb="md"
            />
          )}
          <Markdown text={e.bodyMd} />
        </>
      )}
      <Text size="sm" c="dimmed" mb="md">
        By {e.owner ?? "—"} · created {fmtTime(e.createdAt)}
        {e.publishedAt !== null && <> · published {fmtTime(e.publishedAt)}</>}
        {" · revision "}
        {e.revision}
      </Text>

      <VotePanel e={e} member={member} onChange={ev.reload} act={act} />

      {editable && !editing && (
        <OwnerPanel
          e={e}
          onEdit={() => setEditing(true)}
          onChange={(next) => (next ? ev.set(next) : ev.reload())}
          act={act}
        />
      )}
      {hasRole(me, "admin") && (
        <Group mb="md">
          <Confirm
            label="Delete event (admin)"
            confirmLabel="Yes, delete everything"
            disabled={act.busy}
            onConfirm={async () => {
              const ok = await act.run(async () => {
                await api.deleteEvent(e.id);
                return true;
              });
              if (ok) void nav("/events");
            }}
          />
        </Group>
      )}

      <ShowSection e={e} act={act} onOpened={ev.reload} />

      {/*
       * Collapsed by default to make room for the gallery. Conditionally
       * mounted rather than hidden: `Collapse` keeps its children mounted and
       * their queries would still fire, so the revision list would be fetched
       * on every event page whether or not anyone looked at it.
       */}
      <Group mt="md" gap="xs">
        <Button
          size="compact-sm"
          variant="subtle"
          onClick={() => setHistory((v) => !v)}
        >
          {history ? "Hide page history" : "Page history"}
        </Button>
      </Group>
      {history && <History id={e.id} revision={e.revision} />}

      {e.status !== "draft" && (
        <Comments
          comments={e.comments}
          canPost={member}
          owner={hasRole(me, "admin")}
          onAdd={async (bodyMd) => {
            await api.addEventComment(e.id, bodyMd);
            await ev.reload();
          }}
          onEdit={async (cid, bodyMd) => {
            await api.updateEventComment(e.id, cid, bodyMd);
            await ev.reload();
          }}
          onDelete={async (cid) => {
            await api.deleteEventComment(e.id, cid);
            await ev.reload();
          }}
        />
      )}
    </>
  );
}

/** Date, place and duration — the header line the whole redesign is about. */
function When({ e }: { e: EventDetail }) {
  return (
    <Text size="sm" mb="sm">
      {e.startsAt !== null ? (
        <>
          <strong>{fmtTime(e.startsAt)}</strong> · {e.durationHours}h
        </>
      ) : (
        <>
          Date to be voted · <strong>vote until {fmtTime(e.voteUntil)}</strong>{" "}
          · {e.durationHours}h
        </>
      )}
      {" · "}
      {e.placeUrl ? (
        <Anchor href={e.placeUrl} target="_blank" rel="noopener noreferrer">
          {e.place}
        </Anchor>
      ) : (
        e.place
      )}
    </Text>
  );
}

function StatusSteps({ status }: { status: EventStatus }) {
  const idx = EVENT_STATUSES.indexOf(status);
  return (
    <Stepper
      active={idx}
      size="xs"
      mb="md"
      aria-label="event progress"
      styles={{ steps: { flexWrap: "wrap", rowGap: 8 } }}
    >
      {EVENT_STATUSES.map((s) => (
        <Stepper.Step key={s} label={s} allowStepSelect={false} />
      ))}
    </Stepper>
  );
}

type Act = ReturnType<typeof useAction>;

function VotePanel({
  e,
  member,
  onChange,
  act,
}: {
  e: EventDetail;
  member: boolean;
  onChange: () => Promise<void>;
  act: Act;
}) {
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(e.options.filter((o) => o.mine).map((o) => o.id)),
  );
  const voting = e.status === "voting";
  const counted = e.options.some((o) => o.votes !== undefined);
  const mine = e.options.filter((o) => o.mine).length;
  const best = Math.max(0, ...e.options.map((o) => o.votes ?? 0));

  const save = async () => {
    if (await act.run(() => api.vote(e.id, [...picked]))) await onChange();
  };
  const withdraw = async () => {
    if (
      await act.run(async () => {
        await api.unvote(e.id);
        return true;
      })
    ) {
      setPicked(new Set());
      await onChange();
    }
  };

  return (
    <Card withBorder mb="md">
      <Title order={4} mb="xs">
        {voting
          ? "Date vote"
          : e.status === "draft"
            ? "Candidate dates"
            : "Date vote result"}
      </Title>
      {voting && member && (
        <Text size="sm" c="dimmed" mb="xs">
          Tick every date you can make; you can change your picks until{" "}
          {fmtTime(e.voteUntil)}. Tallies are shown once the vote closes.
        </Text>
      )}
      <Stack gap={6}>
        {e.options.map((o) => (
          <Group key={o.id} gap="sm">
            {voting && member ? (
              <Checkbox
                label={fmtTime(o.startsAt)}
                checked={picked.has(o.id)}
                onChange={(x) => {
                  const next = new Set(picked);
                  if (x.target.checked) next.add(o.id);
                  else next.delete(o.id);
                  setPicked(next);
                }}
              />
            ) : (
              <Text size="sm">{fmtTime(o.startsAt)}</Text>
            )}
            {counted && (
              <Badge
                tone={
                  o.votes === best && e.startsAt === o.startsAt
                    ? "ok"
                    : "neutral"
                }
              >
                {o.votes} vote{o.votes === 1 ? "" : "s"}
              </Badge>
            )}
            {o.mine && !voting && <Badge tone="accent">your pick</Badge>}
            {e.startsAt === o.startsAt && e.startsAt !== null && (
              <Badge tone="ok">decided</Badge>
            )}
          </Group>
        ))}
      </Stack>
      {counted && e.voters !== undefined && (
        <Text size="xs" c="dimmed" mt="xs">
          {e.voters} voter{e.voters === 1 ? "" : "s"} · ties go to the earliest
          date.
        </Text>
      )}
      {voting && member && (
        <Group mt="sm">
          <Button
            size="compact-sm"
            disabled={act.busy || picked.size === 0}
            onClick={() => void save()}
          >
            {mine ? "Update picks" : "Vote"}
          </Button>
          {mine > 0 && (
            <Button
              size="compact-sm"
              variant="default"
              disabled={act.busy}
              onClick={() => void withdraw()}
            >
              Withdraw
            </Button>
          )}
        </Group>
      )}
    </Card>
  );
}

function OwnerPanel({
  e,
  onEdit,
  onChange,
  act,
}: {
  e: EventDetail;
  onEdit: () => void;
  onChange: (next?: EventDetail) => void | Promise<void>;
  act: Act;
}) {
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const publish = async () => {
    const r = await act.run(() => api.publishEvent(e.id));
    if (r) await onChange(r);
  };
  const cancel = async () => {
    const r = await act.run(() => api.cancelEvent(e.id));
    if (r) await onChange(r);
  };
  const upload = async (ev: ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const r = await act.run(() => api.uploadPoster(e.id, file));
      if (r) await onChange(r);
    } finally {
      setUploading(false);
    }
  };
  const removePoster = async () => {
    const ok = await act.run(async () => {
      await api.deletePoster(e.id);
      return true;
    });
    if (ok) await onChange();
  };

  return (
    <Card withBorder mb="md">
      <Title order={4} mb="xs">
        {e.mine ? "Your event" : "Admin"}
      </Title>
      <Group>
        {e.status === "draft" && (
          <Confirm
            label="Publish (open the date vote)"
            confirmLabel="Yes, publish"
            color="brand"
            variant="filled"
            onConfirm={publish}
            disabled={act.busy}
          />
        )}
        <Button size="compact-sm" variant="default" onClick={onEdit}>
          {e.status === "draft" ? "Edit draft" : "Edit page"}
        </Button>
        <Button
          size="compact-sm"
          variant="default"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
        >
          {uploading
            ? "Uploading…"
            : e.posterUrl
              ? "Replace poster"
              : "Upload poster"}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg"
          hidden
          aria-label="Poster file"
          onChange={(x) => void upload(x)}
        />
        {e.posterUrl && (
          <Confirm
            label="Remove poster"
            onConfirm={removePoster}
            disabled={act.busy}
          />
        )}
        <Confirm
          label="Cancel event"
          confirmLabel="Yes, cancel it"
          onConfirm={cancel}
          disabled={act.busy}
        />
      </Group>
      <Text size="sm" c="dimmed" mt="xs">
        {e.status === "draft"
          ? "Only you and admins see a draft. Publishing freezes the candidate dates, the deadline and the duration."
          : "Every edit is kept as a revision; the page history below shows who changed what."}
      </Text>
    </Card>
  );
}

/**
 * The gallery this event spawned, below the page. Deliberately **outside**
 * `OwnerPanel`: that panel disappears once an event is `closed`, which is
 * exactly when its entries matter most (`docs/decisions.md` decision 11).
 */
function ShowSection({
  e,
  act,
  onOpened,
}: {
  e: EventDetail;
  act: ReturnType<typeof useAction>;
  onOpened: () => Promise<void>;
}) {
  const { me } = useAuth();
  const [sort, setSort] = useState<"new" | "likes">("new");
  const entries = useApiQuery(
    ["event-show-entries", e.showId ?? "", sort],
    () => api.showEntries(e.showId!, { sort }),
    { enabled: e.showId !== null },
  );
  if (e.showId === null) {
    if (!e.canEdit && !hasRole(me, "admin")) return null;
    // The API gates on "is this event visible to an anonymous visitor",
    // evaluated on the settled row — offering the button on a draft or a
    // running vote would only ever produce a 409.
    if (!["waiting", "opened", "closed"].includes(e.status)) return null;
    return (
      <Group mt="md" gap="xs">
        <Button
          size="compact-sm"
          disabled={act.busy}
          onClick={() =>
            void (async () => {
              await act.run(() => api.openShowForEvent(e.id));
              await onOpened();
            })()
          }
        >
          Open a show for this event
        </Button>
        <Text size="xs" c="dimmed">
          A gallery where members put up what they built here.
        </Text>
      </Group>
    );
  }
  return (
    <>
      <Group mt="md" mb="xs" justify="space-between">
        <Title order={4}>What people built</Title>
        <Anchor component={Link} to={`/shows/${e.showId}`} size="sm">
          Open the show
        </Anchor>
      </Group>
      {entries.error && <Notice kind="error">{entries.error}</Notice>}
      <EntryGrid
        entries={entries.data?.entries ?? []}
        sort={sort}
        onSort={setSort}
        loading={entries.loading && !entries.data}
      />
    </>
  );
}

/** Revision list plus a two-revision diff (computed here, the API only serves revisions). */
function History({ id, revision }: { id: string; revision: number }) {
  const list = useApiQuery(["event-revisions", id, revision], () =>
    api.eventRevisions(id),
  );
  const [pair, setPair] = useState<{ a: number; b: number } | null>(null);
  const a = pair?.a ?? Math.max(1, revision - 1);
  const b = pair?.b ?? revision;
  const ra = useApiQuery(
    ["event-revision", id, a],
    () => api.eventRevision(id, a),
    {
      enabled: revision > 1,
    },
  );
  const rb = useApiQuery(
    ["event-revision", id, b],
    () => api.eventRevision(id, b),
    {
      enabled: revision > 1,
    },
  );
  const revs = list.data ?? [];
  const choices = revs.map((r) => ({
    value: String(r.revision),
    label: `r${r.revision} · ${r.editedBy ?? "—"} · ${fmtTime(r.editedAt)}`,
  }));

  return (
    <>
      <Title order={4} mt="md" mb="xs">
        Page history
      </Title>
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {revs.length > 0 && (
        <Table.ScrollContainer minWidth={480}>
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Rev</Table.Th>
                <Table.Th>By</Table.Th>
                <Table.Th>At</Table.Th>
                <Table.Th>Title</Table.Th>
                <Table.Th>Place</Table.Th>
                <Table.Th>Poster</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {revs.map((r: EventRevision) => (
                <Table.Tr key={r.revision}>
                  <Table.Td>{r.revision}</Table.Td>
                  <Table.Td>{r.editedBy ?? "—"}</Table.Td>
                  <Table.Td>{fmtTime(r.editedAt)}</Table.Td>
                  <Table.Td>{r.title}</Table.Td>
                  <Table.Td>{r.place}</Table.Td>
                  <Table.Td>{r.posterKey ? "yes" : "—"}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      {revision > 1 && (
        <>
          <Group mt="sm" align="end">
            <Select
              label="From"
              data={choices}
              value={String(a)}
              onChange={(v) => v && setPair({ a: Number(v), b })}
              allowDeselect={false}
            />
            <Select
              label="To"
              data={choices}
              value={String(b)}
              onChange={(v) => v && setPair({ a, b: Number(v) })}
              allowDeselect={false}
            />
          </Group>
          {ra.error && <Notice kind="error">{ra.error}</Notice>}
          {rb.error && <Notice kind="error">{rb.error}</Notice>}
          {ra.data && rb.data && <DiffView a={ra.data} b={rb.data} />}
        </>
      )}
    </>
  );
}

function DiffView({ a, b }: { a: EventRevision; b: EventRevision }) {
  const lines = diffLines(revisionText(a), revisionText(b));
  if (lines.every((l) => l.op === " "))
    return (
      <Text size="sm" c="dimmed" mt="xs">
        No changes between r{a.revision} and r{b.revision}.
      </Text>
    );
  return (
    <Code block mt="xs" aria-label={`diff r${a.revision} r${b.revision}`}>
      {lines.map((l, i) => (
        <div
          key={i}
          style={{
            background:
              l.op === "+"
                ? "var(--mantine-color-green-0)"
                : l.op === "-"
                  ? "var(--mantine-color-red-0)"
                  : undefined,
          }}
        >
          {l.op}
          {l.text}
        </div>
      ))}
    </Code>
  );
}
