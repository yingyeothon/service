import {
  Anchor,
  Button,
  Checkbox,
  Code,
  Group,
  Image,
  Select,
  Stack,
  Stepper,
  Table,
  Text,
} from "@mantine/core";
import { useRef, useState, type ChangeEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { hasRole, useAuth } from "../auth";
import { Comments } from "../components/Comments";
import { Crumbs } from "../components/Crumbs";
import { EventForm } from "../components/EventForm";
import { EntryGrid } from "../components/EntryGrid";
import { PageSkeleton } from "../components/Loading";
import { Markdown } from "../components/Markdown";
import { PageHeader, type HeaderAction } from "../components/PageHeader";
import { ResourceDrawer } from "../components/ResourceDrawer";
import { Section } from "../components/Section";
import { Badge, Notice } from "../components/ui";
import { useConfirm } from "../lib/confirm";
import { diffLines, revisionText } from "../lib/diff";
import { formFromEvent } from "../lib/eventForm";
import { fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
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

const EVENTS_CRUMB = [{ label: "Events", to: "/events" }];

export function EventDetailPage() {
  const { id = "" } = useParams();
  const { me, loading: authLoading } = useAuth();
  const nav = useNavigate();
  // Wait for /me: an anonymous fetch of an in-progress event would 404 and flash an error.
  const ev = useApiQuery(["event", id, me?.id ?? null], () => api.event(id), {
    enabled: !authLoading,
  });
  const act = useAction();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (ev.error)
    return (
      <>
        <Crumbs trail={EVENTS_CRUMB} />
        <PageHeader />
        <Notice kind="error">{ev.error}</Notice>
      </>
    );
  if (!ev.data)
    return (
      <>
        <Crumbs trail={EVENTS_CRUMB} />
        <PageHeader />
        <PageSkeleton />
      </>
    );
  const e = ev.data;
  const member = hasRole(me, "member");
  const admin = hasRole(me, "admin");
  const editable = e.canEdit && EDITABLE.includes(e.status);

  const save = async (input: EventInput | Partial<EventInput>) => {
    const r = await act.run(() => api.updateEvent(e.id, input));
    if (r) {
      setEditing(false);
      ev.set(r);
      notify.saved("event");
    }
  };
  const publish = async () => {
    const ok = await confirm({
      title: "Publish the event?",
      message:
        "Opens the date vote. The candidate dates, the deadline and the duration are frozen from here on.",
      confirmLabel: "Publish event",
    });
    if (!ok.ok) return;
    const r = await act.run(() => api.publishEvent(e.id));
    if (r) {
      ev.set(r);
      notify.done("Event published");
    }
  };
  const cancel = async () => {
    const ok = await confirm({
      title: "Cancel the event?",
      message: "Participants see it as cancelled; nothing is deleted.",
      confirmLabel: "Cancel event",
      danger: true,
    });
    if (!ok.ok) return;
    const r = await act.run(() => api.cancelEvent(e.id));
    if (r) {
      ev.set(r);
      notify.done("Event cancelled");
    }
  };
  const upload = async (x: ChangeEvent<HTMLInputElement>) => {
    const file = x.target.files?.[0];
    x.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const r = await act.run(() => api.uploadPoster(e.id, file));
      if (r) {
        ev.set(r);
        notify.done("Poster uploaded");
      }
    } finally {
      setUploading(false);
    }
  };
  const removePoster = async () => {
    const ok = await confirm({
      title: "Remove the poster?",
      confirmLabel: "Remove poster",
      danger: true,
    });
    if (!ok.ok) return;
    const r = await act.run(async () => {
      await api.deletePoster(e.id);
      return true;
    });
    if (r) {
      notify.done("Poster removed");
      await ev.reload();
    }
  };
  const remove = async () => {
    const ok = await confirm({
      title: "Delete the event?",
      message: "Its votes, revisions, comments and poster go with it.",
      confirmLabel: "Delete event",
      danger: true,
    });
    if (!ok.ok) return;
    const r = await act.run(async () => {
      await api.deleteEvent(e.id);
      return true;
    });
    if (r) {
      notify.deleted("event");
      void nav("/events");
    }
  };

  const actions: HeaderAction[] = [];
  if (editable) {
    if (e.status === "draft")
      actions.push({
        label: "Publish event",
        primary: true,
        onClick: publish,
        disabled: act.busy,
      });
    actions.push({ label: "Edit", onClick: () => setEditing(true) });
    actions.push({
      label: uploading
        ? "Uploading…"
        : e.posterUrl
          ? "Replace poster"
          : "Upload poster",
      menu: true,
      disabled: uploading,
      onClick: () => fileRef.current?.click(),
    });
    if (e.posterUrl)
      actions.push({
        label: "Remove poster",
        menu: true,
        onClick: removePoster,
        disabled: act.busy,
      });
    actions.push({
      label: "Cancel event",
      danger: true,
      onClick: cancel,
      disabled: act.busy,
    });
  }
  if (admin)
    actions.push({
      label: "Delete event",
      danger: true,
      onClick: remove,
      disabled: act.busy,
    });

  return (
    <>
      <Crumbs trail={EVENTS_CRUMB} current={e.title} />
      <PageHeader
        title={e.title}
        badges={<Badge tone={STATUS_TONE[e.status]}>{e.status}</Badge>}
        meta={
          <>
            By {e.owner ?? "—"} · created {fmtTime(e.createdAt)}
            {e.publishedAt !== null && (
              <> · published {fmtTime(e.publishedAt)}</>
            )}
            {" · revision "}
            {e.revision}
          </>
        }
        actions={actions}
      >
        <When e={e} />
        {e.status !== "cancelled" && <StatusSteps status={e.status} />}
      </PageHeader>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        hidden
        aria-label="Poster file"
        onChange={(x) => void upload(x)}
      />
      {e.status === "cancelled" && (
        <Notice kind="error">
          Cancelled {fmtTime(e.cancelledAt)} by {e.cancelledBy ?? "—"}.
        </Notice>
      )}
      {act.error && !editing && <Notice kind="error">{act.error}</Notice>}
      {editable && (
        <Text size="sm" c="dimmed" mb="md">
          {e.status === "draft"
            ? "Only you and admins see a draft. Publishing freezes the candidate dates, the deadline and the duration."
            : "Every edit is kept as a revision; the page history below shows who changed what."}
        </Text>
      )}

      {e.posterUrl && (
        <Image
          src={`${api.posterSrc(e.id)}?v=${e.revision}`}
          alt={`${e.title} poster`}
          maw={420}
          radius="md"
          mb="md"
        />
      )}
      <Markdown text={e.bodyMd} />

      <VotePanel e={e} member={member} onChange={ev.reload} act={act} />

      {admin && e.status === "voting" && (
        <CloseVotePanel e={e} onClosed={ev.reload} act={act} />
      )}

      <ShowSection e={e} act={act} onOpened={ev.reload} />

      {/*
       * Collapsed by default to make room for the gallery. Conditionally
       * mounted rather than hidden: `Collapse` keeps its children mounted and
       * their queries would still fire, so the revision list would be fetched
       * on every event page whether or not anyone looked at it.
       */}
      <Group mt="lg" gap="xs">
        <Button
          variant="subtle"
          color="ink"
          onClick={() => setHistory((v) => !v)}
          aria-expanded={history}
        >
          {history ? "Hide page history" : "Page history"}
        </Button>
      </Group>
      {history && <History id={e.id} revision={e.revision} />}

      {e.status !== "draft" && (
        <Comments
          comments={e.comments}
          canPost={member}
          owner={admin}
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

      <ResourceDrawer
        opened={editing}
        onClose={() => setEditing(false)}
        title={e.status === "draft" ? "Edit draft" : "Edit page"}
        submitLabel="Save"
        onSubmit={() => {}}
        size="lg"
        plain
      >
        {act.error && <Notice kind="error">{act.error}</Notice>}
        {editing && (
          <EventForm
            initial={formFromEvent(e)}
            schedule={e.status === "draft"}
            busy={act.busy}
            submitLabel="Save"
            onSubmit={save}
            onCancel={() => setEditing(false)}
          />
        )}
      </ResourceDrawer>
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

/**
 * Platform admin only: ends a running vote now. Without a pick the standing
 * rule decides; picking a candidate overrides the tally, so the reason is
 * required and lands on the page for every participant to read
 * (`docs/decisions.md` *Hackathon workflow*, early close).
 */
function CloseVotePanel({
  e,
  onClosed,
  act,
}: {
  e: EventDetail;
  onClosed: () => Promise<void>;
  act: Act;
}) {
  const confirm = useConfirm();
  // "" is the standing rule; the API rejects an empty `optionId`, so the
  // empty string must never leave this component.
  const [optionId, setOptionId] = useState<string>("");
  const close = async () => {
    const r = await confirm({
      title: "Close the vote now?",
      message:
        "Members can no longer change their picks. The reason is shown publicly on the event page and cannot be edited afterwards.",
      confirmLabel: "Yes, close it",
      danger: true,
      reason: {
        required: true,
        maxLength: 500,
        placeholder: "Why is it ending early?",
      },
    });
    if (!r.ok || r.reason === undefined) return;
    const ok = await act.run(() =>
      api
        .closeEventVote(e.id, r.reason!, optionId || undefined)
        .then(() => true),
    );
    if (ok) {
      notify.done("Vote closed");
      await onClosed();
    }
  };
  return (
    <Section
      title="Close the vote now (admin)"
      description={
        <>
          Ends the vote before {fmtTime(e.voteUntil)} and fixes the date.
          Members can no longer change their picks. Unlike the other reasons you
          give as an admin,{" "}
          <strong>this one is shown publicly on the event page</strong> and
          cannot be edited afterwards.
        </>
      }
    >
      <Group gap="sm" align="flex-end">
        <Select
          label="Decided date"
          value={optionId}
          onChange={(v) => setOptionId(v ?? "")}
          data={[
            { value: "", label: "Most votes (the standing rule)" },
            ...e.options.map((o) => ({
              value: o.id,
              label: fmtTime(o.startsAt),
            })),
          ]}
          style={{ minWidth: 260 }}
        />
        <Button
          variant="outline"
          color="red"
          disabled={act.busy}
          onClick={() => void close()}
        >
          Close the vote
        </Button>
      </Group>
    </Section>
  );
}

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
    if (await act.run(() => api.vote(e.id, [...picked]))) {
      notify.done("Picks saved");
      await onChange();
    }
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
    <Section
      title={
        voting
          ? "Date vote"
          : e.status === "draft"
            ? "Candidate dates"
            : "Date vote result"
      }
      description={
        voting && member
          ? `Tick every date you can make; you can change your picks until ${fmtTime(e.voteUntil)}. Tallies are shown once the vote closes.`
          : undefined
      }
    >
      {e.voteClosedAt !== null && (
        <Notice kind="warn">
          Vote closed early by {e.voteClosedBy ?? "an admin"} on{" "}
          {fmtTime(e.voteClosedAt)} — {e.voteClosedReason}
          {e.voteOverridden === true && (
            <>
              {" "}
              <strong>
                The date was chosen, not the one the votes point to.
              </strong>
            </>
          )}
        </Notice>
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
          {e.voters} voter{e.voters === 1 ? "" : "s"}
          {/*
           * The tie rule still explains the date on an early close that did
           * not override the tally — and that is the case where it explains
           * the most, since an early close often finds nobody has voted.
           */}
          {e.voteOverridden === true
            ? " · an admin picked this date."
            : " · ties go to the earliest date."}
        </Text>
      )}
      {voting && member && (
        <Group mt="md">
          <Button
            variant="default"
            disabled={act.busy || picked.size === 0}
            onClick={() => void save()}
          >
            {mine ? "Update picks" : "Vote"}
          </Button>
          {mine > 0 && (
            <Button
              variant="subtle"
              color="ink"
              disabled={act.busy}
              onClick={() => void withdraw()}
            >
              Withdraw
            </Button>
          )}
        </Group>
      )}
    </Section>
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
      <Section
        title="What people built"
        description="A gallery where members put up what they built here."
        actions={
          <Button
            variant="default"
            disabled={act.busy}
            onClick={() =>
              void (async () => {
                const ok = await act.run(() =>
                  api.openShowForEvent(e.id).then(() => true),
                );
                if (ok) notify.done("Show opened");
                await onOpened();
              })()
            }
          >
            Open a show for this event
          </Button>
        }
      >
        <Text size="sm" c="dimmed">
          No show yet.
        </Text>
      </Section>
    );
  }
  return (
    <Section
      title="What people built"
      actions={
        <Button component={Link} to={`/shows/${e.showId}`} variant="default">
          Open the show
        </Button>
      }
    >
      {entries.error && <Notice kind="error">{entries.error}</Notice>}
      <EntryGrid
        entries={entries.data?.entries ?? []}
        sort={sort}
        onSort={setSort}
        loading={entries.loading && !entries.data}
      />
    </Section>
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
    <Section title="Revisions">
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {revs.length > 0 && (
        <Table.ScrollContainer minWidth={480}>
          <Table>
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
    </Section>
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
