import {
  Anchor,
  Button,
  Card,
  Group,
  Image,
  Stack,
  Stepper,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { hasRole, useAuth } from "../auth";
import { Badge, Confirm, Notice, Spinner } from "../components/ui";
import { fmtTime } from "../lib/format";
import { renderBody } from "../lib/text";
import { useAction, useApiQuery } from "../lib/query";
import {
  EVENT_STATUSES,
  type EventDetail,
  type EventStatus,
  type Proposal,
} from "../types";
import { STATUS_TONE } from "./Events";

const PROPOSALS_PER_MEMBER = 3;
const NEXT_LABEL: Partial<Record<EventStatus, string>> = {
  proposing: "Open proposals",
  voting: "Start voting",
  decided: "Close voting",
  published: "Publish",
  closed: "Close event",
};

export function EventDetailPage() {
  const { id = "" } = useParams();
  const { me, loading: authLoading } = useAuth();
  // Wait for /me: an anonymous fetch of an in-progress event would 404 and flash an error.
  const ev = useApiQuery(["event", id, me?.id ?? null], () => api.event(id), {
    enabled: !authLoading,
  });
  const props = useApiQuery(
    ["proposals", id, me?.id ?? null],
    () =>
      ev.data && (me || ["published", "closed"].includes(ev.data.status))
        ? api.proposals(id)
        : Promise.resolve({ proposals: [], myVote: null }),
    { enabled: ev.data !== undefined },
  );
  const act = useAction();
  const admin = hasRole(me, "admin");

  if (ev.error) return <Notice kind="error">{ev.error}</Notice>;
  if (!ev.data) return <Spinner />;
  const e = ev.data;
  const next = EVENT_STATUSES[EVENT_STATUSES.indexOf(e.status) + 1];

  const refreshAll = async () => {
    await ev.reload();
    await props.reload();
  };

  return (
    <>
      <Text size="sm" mb="xs">
        <Anchor component={Link} to="/events">
          ← Events
        </Anchor>
      </Text>
      <Group gap="xs" mb="sm">
        <Title order={2}>{e.title}</Title>
        <Badge tone={STATUS_TONE[e.status]}>{e.status}</Badge>
      </Group>
      <StatusSteps status={e.status} />
      {act.error && <Notice kind="error">{act.error}</Notice>}

      {e.posterUrl && (
        <Image
          src={`${api.posterSrc(e.id)}?v=${e.updatedAt}`}
          alt={`${e.title} poster`}
          maw={420}
          radius="sm"
          mb="md"
        />
      )}
      <div>{renderBody(e.bodyMd)}</div>
      <Text size="sm" c="dimmed" mb="md">
        Created {fmtTime(e.createdAt)}
        {e.publishedAt !== null && <> · Published {fmtTime(e.publishedAt)}</>}
      </Text>

      {e.winner && (
        <Card
          withBorder
          mb="md"
          style={{ borderColor: "var(--mantine-color-green-5)" }}
        >
          <Title order={4}>Winning proposal</Title>
          <ProposalCard p={e.winner} />
        </Card>
      )}

      {admin && (
        <AdminPanel
          e={e}
          next={next}
          proposals={props.data?.proposals ?? []}
          onChange={refreshAll}
          act={act}
        />
      )}

      <ProposalsSection
        e={e}
        data={props.data}
        loading={props.loading}
        error={props.error}
        onChange={refreshAll}
        act={act}
      />
    </>
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

function AdminPanel({
  e,
  next,
  proposals,
  onChange,
  act,
}: {
  e: EventDetail;
  next: EventStatus | undefined;
  proposals: Proposal[];
  onChange: () => Promise<void>;
  act: Act;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(e.title);
  const [body, setBody] = useState(e.bodyMd);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const canPoster = ["decided", "published", "closed"].includes(e.status);

  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    const r = await act.run(() =>
      api.updateEvent(e.id, { title: title.trim(), bodyMd: body }),
    );
    if (r) {
      setEditing(false);
      await onChange();
    }
  };
  const transition = async () => {
    if (!next) return;
    if (await act.run(() => api.transitionEvent(e.id, next))) await onChange();
  };
  const decide = async (pid: string) => {
    if (await act.run(() => api.decideEvent(e.id, pid))) await onChange();
  };
  const upload = async (ev: ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      if (await act.run(() => api.uploadPoster(e.id, file))) await onChange();
    } finally {
      setUploading(false);
    }
  };
  const removePoster = async () => {
    if (
      await act.run(async () => {
        await api.deletePoster(e.id);
        return true;
      })
    )
      await onChange();
  };

  return (
    <Card withBorder mb="md">
      <Title order={4} mb="xs">
        Admin
      </Title>
      <Group>
        {next && (
          <Confirm
            label={`${NEXT_LABEL[next] ?? next} (${e.status} → ${next})`}
            confirmLabel={`Yes, ${next}`}
            color="brand"
            variant="filled"
            onConfirm={transition}
            disabled={act.busy || (next === "published" && !e.winner)}
          />
        )}
        {next === "published" && !e.winner && (
          <Text size="sm" c="dimmed">
            Pick a winner below before publishing.
          </Text>
        )}
        {next === "voting" && proposals.length === 0 && (
          <Text size="sm" c="dimmed">
            Voting needs at least one proposal.
          </Text>
        )}
        {!editing && (
          <Button
            size="compact-sm"
            variant="default"
            onClick={() => {
              setTitle(e.title);
              setBody(e.bodyMd);
              setEditing(true);
            }}
          >
            Edit text
          </Button>
        )}
        {canPoster && (
          <>
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
          </>
        )}
        {canPoster && e.posterUrl && (
          <Confirm
            label="Remove poster"
            onConfirm={removePoster}
            disabled={act.busy}
          />
        )}
      </Group>
      {!canPoster && (
        <Text size="sm" c="dimmed" mt="xs">
          Posters can be uploaded once voting has closed (png/jpeg ≤ 5 MB).
        </Text>
      )}
      {editing && (
        <form onSubmit={(x) => void save(x)}>
          <Stack gap="sm" mt="sm">
            <TextInput
              label="Title"
              value={title}
              onChange={(x) => setTitle(x.target.value)}
              required
              maxLength={200}
            />
            <Textarea
              label="Description (plain text; blank line = paragraph, URLs are linked)"
              value={body}
              onChange={(x) => setBody(x.target.value)}
              maxLength={20000}
              autosize
              minRows={4}
            />
            <Group>
              <Button type="submit" disabled={act.busy}>
                Save
              </Button>
              <Button variant="default" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </Group>
          </Stack>
        </form>
      )}
      {e.status === "decided" && (
        <>
          <Title order={4} mt="sm" mb="xs">
            Results
          </Title>
          {proposals.length === 0 ? (
            <Text size="sm" c="dimmed">
              No proposals.
            </Text>
          ) : (
            <Table.ScrollContainer minWidth={480}>
              <Table striped>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Votes</Table.Th>
                    <Table.Th>Proposal</Table.Th>
                    <Table.Th>By</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {[...proposals]
                    .sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0))
                    .map((p) => (
                      <Table.Tr key={p.id}>
                        <Table.Td>{p.votes ?? 0}</Table.Td>
                        <Table.Td>{p.title}</Table.Td>
                        <Table.Td>{p.memberLogin ?? "—"}</Table.Td>
                        <Table.Td>
                          {e.winner?.id === p.id ? (
                            <Badge tone="ok">winner</Badge>
                          ) : (
                            <Button
                              size="compact-sm"
                              variant="default"
                              disabled={act.busy}
                              onClick={() => void decide(p.id)}
                            >
                              {e.winner ? "Make winner instead" : "Make winner"}
                            </Button>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </>
      )}
    </Card>
  );
}

function ProposalCard({ p }: { p: Proposal }) {
  return (
    <>
      <Title order={5}>{p.title}</Title>
      <Text size="sm" c="dimmed">
        by {p.memberLogin ?? "—"} · {fmtTime(p.createdAt)}
        {p.votes !== undefined && (
          <>
            {" "}
            · {p.votes} vote{p.votes === 1 ? "" : "s"}
          </>
        )}
      </Text>
      <div>{renderBody(p.bodyMd)}</div>
    </>
  );
}

function ProposalsSection({
  e,
  data,
  loading,
  error,
  onChange,
  act,
}: {
  e: EventDetail;
  data: { proposals: Proposal[]; myVote: string | null } | undefined;
  loading: boolean;
  error: string | null;
  onChange: () => Promise<void>;
  act: Act;
}) {
  const { me } = useAuth();
  const admin = hasRole(me, "admin");
  const [draft, setDraft] = useState<{
    id?: string;
    title: string;
    bodyMd: string;
  } | null>(null);
  const proposals = data?.proposals ?? [];
  const mine = proposals.filter((p) => p.mine).length;
  const canPropose =
    !!me && e.status === "proposing" && mine < PROPOSALS_PER_MEMBER;
  const voting = !!me && e.status === "voting";

  if (!me && !["published", "closed"].includes(e.status)) return null;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!draft) return;
    const body = { title: draft.title.trim(), bodyMd: draft.bodyMd };
    const r = await act.run(() =>
      draft.id
        ? api.updateProposal(e.id, draft.id, body)
        : api.createProposal(e.id, body),
    );
    if (r) {
      setDraft(null);
      await onChange();
    }
  };
  const withdraw = async (pid: string) => {
    if (
      await act.run(async () => {
        await api.deleteProposal(e.id, pid);
        return true;
      })
    )
      await onChange();
  };
  const vote = async (pid: string) => {
    if (await act.run(() => api.vote(e.id, pid))) await onChange();
  };
  const unvote = async () => {
    if (
      await act.run(async () => {
        await api.unvote(e.id);
        return true;
      })
    )
      await onChange();
  };

  return (
    <>
      <Group justify="space-between" mb="xs">
        <Title order={3}>
          Proposals {proposals.length ? `(${proposals.length})` : ""}
        </Title>
        {canPropose && !draft && (
          <Button
            size="compact-sm"
            onClick={() => setDraft({ title: "", bodyMd: "" })}
          >
            New proposal ({mine}/{PROPOSALS_PER_MEMBER})
          </Button>
        )}
      </Group>
      {e.status === "proposing" && me?.role === "pending" && (
        <Text size="sm" c="dimmed" mb="xs">
          Pending members can propose and vote.
        </Text>
      )}
      {voting && (
        <Notice>
          Voting is open: one vote per member, changeable until voting closes.{" "}
          {data?.myVote ? (
            <>
              You voted for{" "}
              <strong>
                {proposals.find((p) => p.id === data.myVote)?.title ??
                  data.myVote}
              </strong>
              .{" "}
              <Button
                size="compact-sm"
                variant="default"
                disabled={act.busy}
                onClick={() => void unvote()}
              >
                Withdraw vote
              </Button>
            </>
          ) : (
            "You have not voted yet."
          )}
        </Notice>
      )}
      {draft && (
        <Card withBorder mb="md">
          <form onSubmit={(x) => void submit(x)}>
            <Stack gap="sm">
              <TextInput
                label="Title"
                value={draft.title}
                onChange={(x) => setDraft({ ...draft, title: x.target.value })}
                required
                maxLength={200}
              />
              <Textarea
                label="Details (plain text)"
                value={draft.bodyMd}
                onChange={(x) => setDraft({ ...draft, bodyMd: x.target.value })}
                maxLength={20000}
                autosize
                minRows={4}
              />
              <Group>
                <Button
                  type="submit"
                  disabled={act.busy || !draft.title.trim()}
                >
                  {draft.id ? "Save" : "Submit"}
                </Button>
                <Button variant="default" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
              </Group>
            </Stack>
          </form>
        </Card>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {loading && !data ? (
        <Spinner />
      ) : proposals.length === 0 ? (
        <Text size="sm" c="dimmed">
          No proposals yet.
        </Text>
      ) : (
        proposals.map((p) => (
          <Card
            key={p.id}
            withBorder
            mb="sm"
            style={
              e.winner?.id === p.id
                ? { borderColor: "var(--mantine-color-green-5)" }
                : undefined
            }
          >
            <ProposalCard p={p} />
            <Group mt="xs">
              {e.winner?.id === p.id && <Badge tone="ok">winner</Badge>}
              {p.mine && <Badge>mine</Badge>}
              {voting && data?.myVote !== p.id && (
                <Button
                  size="compact-sm"
                  disabled={act.busy}
                  onClick={() => void vote(p.id)}
                >
                  Vote
                </Button>
              )}
              {voting && data?.myVote === p.id && (
                <Badge tone="accent">your vote</Badge>
              )}
              {p.mine && e.status === "proposing" && !draft && (
                <Button
                  size="compact-sm"
                  variant="default"
                  onClick={() =>
                    setDraft({ id: p.id, title: p.title, bodyMd: p.bodyMd })
                  }
                >
                  Edit
                </Button>
              )}
              {((p.mine && e.status === "proposing") ||
                (admin && ["proposing", "voting"].includes(e.status))) &&
                e.winner?.id !== p.id && (
                  <Confirm
                    label={p.mine ? "Withdraw" : "Delete (admin)"}
                    onConfirm={() => withdraw(p.id)}
                    disabled={act.busy}
                  />
                )}
            </Group>
          </Card>
        ))
      )}
    </>
  );
}
