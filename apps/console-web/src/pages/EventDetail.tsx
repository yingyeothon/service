import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { hasRole, useAuth } from "../auth";
import { Badge, Confirm, Notice, Spinner } from "../components/ui";
import { fmtTime } from "../lib/format";
import { renderBody } from "../lib/text";
import { useAction, useAsync } from "../lib/useAsync";
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
  const ev = useAsync(
    () => (authLoading ? new Promise<EventDetail>(() => {}) : api.event(id)),
    [id, me?.id, authLoading],
  );
  const props = useAsync(
    // Anonymous viewers only get proposals for published/closed events.
    () =>
      ev.data && (me || ["published", "closed"].includes(ev.data.status))
        ? api.proposals(id)
        : Promise.resolve({ proposals: [], myVote: null }),
    [id, me?.id, ev.data?.status],
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
      <p>
        <Link to="/events">← Events</Link>
      </p>
      <h1>
        {e.title} <Badge tone={STATUS_TONE[e.status]}>{e.status}</Badge>
      </h1>
      <StatusSteps status={e.status} />
      {act.error && <Notice kind="error">{act.error}</Notice>}

      {e.posterUrl && (
        <img
          className="poster"
          src={`${api.posterSrc(e.id)}?v=${e.updatedAt}`}
          alt={`${e.title} poster`}
        />
      )}
      <div className="body">{renderBody(e.bodyMd)}</div>
      <p className="muted">
        Created {fmtTime(e.createdAt)}
        {e.publishedAt !== null && <> · Published {fmtTime(e.publishedAt)}</>}
      </p>

      {e.winner && (
        <div className="card winner">
          <h3>Winning proposal</h3>
          <ProposalCard p={e.winner} />
        </div>
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
    <div className="steps" aria-label="event progress">
      {EVENT_STATUSES.map((s, i) => (
        <span
          key={s}
          className={`step ${i < idx ? "done" : i === idx ? "now" : ""}`}
        >
          {s}
        </span>
      ))}
    </div>
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
    <div className="card">
      <h3>Admin</h3>
      <div className="row">
        {next && (
          <Confirm
            label={`${NEXT_LABEL[next] ?? next} (${e.status} → ${next})`}
            confirmLabel={`Yes, ${next}`}
            className="btn btn-primary btn-sm"
            onConfirm={transition}
            disabled={act.busy || (next === "published" && !e.winner)}
          />
        )}
        {next === "published" && !e.winner && (
          <span className="muted">Pick a winner below before publishing.</span>
        )}
        {next === "voting" && proposals.length === 0 && (
          <span className="muted">Voting needs at least one proposal.</span>
        )}
        {!editing && (
          <button
            className="btn btn-sm"
            onClick={() => {
              setTitle(e.title);
              setBody(e.bodyMd);
              setEditing(true);
            }}
          >
            Edit text
          </button>
        )}
        {canPoster && (
          <>
            <button
              type="button"
              className="btn btn-sm"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading
                ? "Uploading…"
                : e.posterUrl
                  ? "Replace poster"
                  : "Upload poster"}
            </button>
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
      </div>
      {!canPoster && (
        <p className="muted">
          Posters can be uploaded once voting has closed (png/jpeg ≤ 5 MB).
        </p>
      )}
      {editing && (
        <form
          className="stack"
          onSubmit={(x) => void save(x)}
          style={{ marginTop: "0.8rem" }}
        >
          <label className="field">
            Title
            <input
              value={title}
              onChange={(x) => setTitle(x.target.value)}
              required
              maxLength={200}
            />
          </label>
          <label className="field">
            Description (plain text; blank line = paragraph, URLs are linked)
            <textarea
              value={body}
              onChange={(x) => setBody(x.target.value)}
              maxLength={20000}
            />
          </label>
          <div className="row">
            <button className="btn btn-primary" disabled={act.busy}>
              Save
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {e.status === "decided" && (
        <>
          <h3 style={{ marginTop: "0.8rem" }}>Results</h3>
          {proposals.length === 0 ? (
            <p className="muted">No proposals.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Votes</th>
                  <th>Proposal</th>
                  <th>By</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...proposals]
                  .sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0))
                  .map((p) => (
                    <tr key={p.id}>
                      <td>{p.votes ?? 0}</td>
                      <td>{p.title}</td>
                      <td>{p.memberLogin ?? "—"}</td>
                      <td>
                        {e.winner?.id === p.id ? (
                          <Badge tone="ok">winner</Badge>
                        ) : (
                          <button
                            className="btn btn-sm"
                            disabled={act.busy}
                            onClick={() => void decide(p.id)}
                          >
                            {e.winner ? "Make winner instead" : "Make winner"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function ProposalCard({ p }: { p: Proposal }) {
  return (
    <>
      <h3>{p.title}</h3>
      <p className="muted">
        by {p.memberLogin ?? "—"} · {fmtTime(p.createdAt)}
        {p.votes !== undefined && (
          <>
            {" "}
            · {p.votes} vote{p.votes === 1 ? "" : "s"}
          </>
        )}
      </p>
      <div className="body">{renderBody(p.bodyMd)}</div>
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
      <div className="row spread">
        <h2>Proposals {proposals.length ? `(${proposals.length})` : ""}</h2>
        {canPropose && !draft && (
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setDraft({ title: "", bodyMd: "" })}
          >
            New proposal ({mine}/{PROPOSALS_PER_MEMBER})
          </button>
        )}
      </div>
      {e.status === "proposing" && me?.role === "pending" && (
        <p className="muted">Pending members can propose and vote.</p>
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
              <button
                className="btn btn-sm"
                disabled={act.busy}
                onClick={() => void unvote()}
              >
                Withdraw vote
              </button>
            </>
          ) : (
            "You have not voted yet."
          )}
        </Notice>
      )}
      {draft && (
        <form className="stack card" onSubmit={(x) => void submit(x)}>
          <label className="field">
            Title
            <input
              value={draft.title}
              onChange={(x) => setDraft({ ...draft, title: x.target.value })}
              required
              maxLength={200}
            />
          </label>
          <label className="field">
            Details (plain text)
            <textarea
              value={draft.bodyMd}
              onChange={(x) => setDraft({ ...draft, bodyMd: x.target.value })}
              maxLength={20000}
            />
          </label>
          <div className="row">
            <button
              className="btn btn-primary"
              disabled={act.busy || !draft.title.trim()}
            >
              {draft.id ? "Save" : "Submit"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setDraft(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {loading && !data ? (
        <Spinner />
      ) : proposals.length === 0 ? (
        <p className="muted">No proposals yet.</p>
      ) : (
        proposals.map((p) => (
          <div
            key={p.id}
            className={`card${e.winner?.id === p.id ? " winner" : ""}`}
          >
            <ProposalCard p={p} />
            <div className="row">
              {e.winner?.id === p.id && <Badge tone="ok">winner</Badge>}
              {p.mine && <Badge>mine</Badge>}
              {voting && data?.myVote !== p.id && (
                <button
                  className="btn btn-primary btn-sm"
                  disabled={act.busy}
                  onClick={() => void vote(p.id)}
                >
                  Vote
                </button>
              )}
              {voting && data?.myVote === p.id && (
                <Badge tone="accent">your vote</Badge>
              )}
              {p.mine && e.status === "proposing" && !draft && (
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    setDraft({ id: p.id, title: p.title, bodyMd: p.bodyMd })
                  }
                >
                  Edit
                </button>
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
            </div>
          </div>
        ))
      )}
    </>
  );
}
