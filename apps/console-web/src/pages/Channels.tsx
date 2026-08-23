import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { Badge, Notice, Spinner } from "../components/ui";
import { fmtRelative, fmtTime } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import type { ChannelKind, ChannelStatus } from "../types";

const STATUS_TONE: Record<ChannelStatus, string> = {
  active: "ok",
  expired: "warn",
  disabled: "danger",
};

export function ChannelsPage() {
  const { me } = useAuth();
  const [kind, setKind] = useState<ChannelKind | "">("");
  const [all, setAll] = useState(false);
  const list = useAsync(
    () =>
      api.channels({
        kind: kind || undefined,
        scope: all ? "all" : undefined,
      }),
    [kind, all],
  );
  return (
    <>
      <div className="row spread">
        <h1 style={{ margin: 0 }}>Channels</h1>
        <Link className="btn btn-primary" to="/channels/new">
          New channel
        </Link>
      </div>
      <p className="muted">
        Channels expire 7 days after creation; extend them from the detail page
        (up to 28 days ahead). Expired channels are disabled, then deleted 30
        days later.
      </p>
      <div className="row">
        <label className="field">
          Kind
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ChannelKind | "")}
          >
            <option value="">all</option>
            <option value="auth">auth</option>
            <option value="topic">topic</option>
            <option value="match">match</option>
          </select>
        </label>
        {me?.role === "admin" && (
          <label className="field">
            Scope
            <select
              value={all ? "all" : "mine"}
              onChange={(e) => setAll(e.target.value === "all")}
            >
              <option value="mine">mine</option>
              <option value="all">everyone (admin)</option>
            </select>
          </label>
        )}
      </div>
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Id</th>
              <th>Status</th>
              <th>Expires</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link to={`/channels/${encodeURIComponent(c.id)}`}>
                    {c.name}
                  </Link>
                  {all && c.ownerId !== me?.id && (
                    <span className="muted"> · {c.ownerId}</span>
                  )}
                </td>
                <td>{c.kind}</td>
                <td>
                  <code>{c.id}</code>
                </td>
                <td>
                  <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
                </td>
                <td title={fmtTime(c.expiresAt)}>{fmtRelative(c.expiresAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No channels yet.</p>
      )}
    </>
  );
}
