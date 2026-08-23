import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { hasRole, useAuth } from "../auth";
import { Badge, Notice, Spinner } from "../components/ui";
import { fmtTime } from "../lib/format";
import { useAction, useAsync } from "../lib/useAsync";
import type { EventStatus } from "../types";

export const STATUS_TONE: Record<EventStatus, string> = {
  draft: "neutral",
  proposing: "accent",
  voting: "accent",
  decided: "warn",
  published: "ok",
  closed: "neutral",
};

export function EventsPage() {
  const { me, loading } = useAuth();
  const list = useAsync(() => api.events(), [me?.id]);
  const act = useAction();
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() =>
      api.createEvent({ title: title.trim(), bodyMd: "" }),
    );
    if (!r) return;
    setTitle("");
    setCreating(false);
    await list.reload();
  };

  return (
    <>
      <div className="row spread">
        <h1 style={{ margin: 0 }}>Hackathon events</h1>
        {hasRole(me, "admin") && (
          <button
            className="btn btn-primary"
            onClick={() => setCreating((v) => !v)}
          >
            New event
          </button>
        )}
      </div>
      {!loading && !me && (
        <p className="muted">
          Only published events are listed.{" "}
          <a href={api.loginUrl("/events")}>Sign in</a> to see events in
          progress and take part.
        </p>
      )}
      {creating && (
        <form className="row card" onSubmit={(e) => void create(e)}>
          <input
            aria-label="Event title"
            placeholder="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
          />
          <button
            className="btn btn-primary"
            disabled={act.busy || !title.trim()}
          >
            Create draft
          </button>
        </form>
      )}
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Updated</th>
              <th>Published</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((ev) => (
              <tr key={ev.id}>
                <td>
                  <Link to={`/events/${encodeURIComponent(ev.id)}`}>
                    {ev.title}
                  </Link>
                  {ev.hasPoster && <span className="muted"> · poster</span>}
                </td>
                <td>
                  <Badge tone={STATUS_TONE[ev.status]}>{ev.status}</Badge>
                </td>
                <td>{fmtTime(ev.updatedAt)}</td>
                <td>{fmtTime(ev.publishedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No events.</p>
      )}
    </>
  );
}
