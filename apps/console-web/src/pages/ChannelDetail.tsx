import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { ChannelForm } from "../components/ChannelForm";
import {
  Badge,
  Confirm,
  CopyField,
  Notice,
  SecretOnce,
  Spinner,
} from "../components/ui";
import { buildConfig, emptyForm, formFromChannel } from "../lib/channelForm";
import { errorMessage, fmtRelative, fmtTime } from "../lib/format";
import { useAction, useAsync } from "../lib/useAsync";
import type { AuthConfig, Channel, MatchConfig, TopicConfig } from "../types";

export function ChannelDetailPage() {
  const { id = "" } = useParams();
  const { me } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const ch = useAsync(() => api.channel(id), [id]);
  const auths = useAsync(() => api.channels({ kind: "auth" }), []);
  const act = useAction();
  const [shown, setShown] = useState<string | null>(
    (loc.state as { shown?: string } | null)?.shown ?? null,
  );
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    // Drop the once-shown secret from history state so back/forward never re-shows it.
    if ((loc.state as { shown?: string } | null)?.shown)
      void nav(loc.pathname, { replace: true, state: null });
  }, [loc.state, loc.pathname, nav]);

  if (ch.error) return <Notice kind="error">{ch.error}</Notice>;
  if (!ch.data) return <Spinner />;
  const c = ch.data;
  const owner = c.ownerId === me?.id;
  const secretLabel = c.kind === "auth" ? "Channel secret" : "API key";

  const startEdit = () => {
    setForm(formFromChannel(c));
    setEditing(true);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    let config: unknown;
    try {
      config = buildConfig(c.kind, form, "patch", c);
      setLocalError(null);
    } catch (err) {
      setLocalError(errorMessage(err));
      return;
    }
    const r = await act.run(() =>
      api.updateChannel(c.id, { name: form.name.trim(), config }),
    );
    if (r) {
      ch.set(r);
      setEditing(false);
    }
  };
  const extend = async () => {
    const r = await act.run(() => api.extendChannel(c.id));
    if (r) ch.set(r);
  };
  const rotate = async () => {
    const r = await act.run(() => api.rotateChannelSecret(c.id));
    if (r) {
      setShown(r.secret ?? r.apiKey ?? null);
      ch.set(r);
    }
  };
  const remove = async () => {
    const ok = await act.run(async () => {
      await api.deleteChannel(c.id);
      return true;
    });
    if (ok) void nav("/channels");
  };

  return (
    <>
      <p>
        <Link to="/channels">← Channels</Link>
      </p>
      <div className="row spread">
        <h1 style={{ margin: 0 }}>
          {c.name} <Badge>{c.kind}</Badge>{" "}
          <Badge
            tone={
              c.status === "active"
                ? "ok"
                : c.status === "expired"
                  ? "warn"
                  : "danger"
            }
          >
            {c.status}
          </Badge>
        </h1>
      </div>
      {!owner && (
        <Notice>
          Owned by another member; admins can extend or delete but not edit or
          rotate.
        </Notice>
      )}
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {shown && (
        <SecretOnce
          label={secretLabel}
          value={shown}
          onDismiss={() => setShown(null)}
        />
      )}

      <div className="card">
        <CopyField label="Channel id" value={c.id} />
        {c.kind === "auth" && <AuthDetails c={c} />}
        {c.kind === "topic" && <TopicDetails c={c} />}
        {c.kind === "match" && <MatchDetails c={c} />}
        <p className="muted">
          Created {fmtTime(c.createdAt)} · Expires {fmtTime(c.expiresAt)} (
          {fmtRelative(c.expiresAt)})
          {c.disabledAt !== null && <> · Disabled {fmtTime(c.disabledAt)}</>}
        </p>
        <div className="row">
          <button
            className="btn btn-sm"
            disabled={act.busy}
            onClick={() => void extend()}
          >
            Extend +7 days
          </button>
          {owner && !editing && (
            <button
              className="btn btn-sm"
              disabled={act.busy}
              onClick={startEdit}
            >
              Edit
            </button>
          )}
          {owner && (
            <Confirm
              label={`Rotate ${secretLabel.toLowerCase()}`}
              className="btn btn-sm"
              onConfirm={rotate}
              disabled={act.busy}
            />
          )}
          <Confirm label="Delete" onConfirm={remove} disabled={act.busy} />
        </div>
      </div>

      {editing && (
        <form className="stack card" onSubmit={(e) => void save(e)}>
          <h2 style={{ margin: 0 }}>Edit</h2>
          <ChannelForm
            kind={c.kind}
            form={form}
            onChange={setForm}
            authChannels={auths.data ?? []}
            editing
          />
          {localError && <Notice kind="error">{localError}</Notice>}
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
    </>
  );
}

function AuthDetails({ c }: { c: Channel }) {
  const cfg = c.config as AuthConfig;
  const providers = Object.keys(cfg.providers);
  return (
    <>
      <CopyField label="Issuer" value={c.issuer ?? ""} />
      <CopyField label="Audience" value={cfg.audience} />
      <CopyField label="Start URL" value={c.startUrl ?? ""} />
      {Object.entries(c.callbackUrls ?? {}).map(([p, url]) => (
        <CopyField key={p} label={`${p} callback`} value={url} />
      ))}
      <p className="muted">
        Token TTL {cfg.tokenTtlSec}s · Providers:{" "}
        {providers.length
          ? providers.join(", ")
          : "none (set one to enable login)"}
      </p>
      <p className="muted">
        Redirect allowlist:{" "}
        {cfg.redirectAllowlist.length ? (
          cfg.redirectAllowlist.map((u) => (
            <code key={u} style={{ marginRight: "0.5rem" }}>
              {u}
            </code>
          ))
        ) : (
          <em>empty — logins cannot redirect anywhere</em>
        )}
      </p>
      <p className="muted">
        Register the callback URL{providers.length > 1 ? "s" : ""} above in the
        OAuth app{providers.length > 1 ? "s" : ""}. Games verify JWTs with
        issuer <code>{c.issuer}</code> and audience <code>{cfg.audience}</code>.
      </p>
    </>
  );
}

function TopicDetails({ c }: { c: Channel }) {
  const cfg = c.config as TopicConfig;
  return (
    <>
      <CopyField label="API base" value={c.apiBase ?? ""} />
      <CopyField label="WebSocket URL" value={c.wsUrl ?? ""} />
      <CopyField label="Auth channel" value={cfg.authChannelId} />
      <p className="muted">
        Create topics with <code>POST {c.apiBase}/t</code> using the API key as
        Bearer; clients subscribe over the WebSocket with a player JWT.
      </p>
    </>
  );
}

function MatchDetails({ c }: { c: Channel }) {
  const cfg = c.config as MatchConfig;
  return (
    <>
      <CopyField label="WebSocket URL" value={c.wsUrl ?? ""} />
      <CopyField label="Auth channel" value={cfg.authChannelId} />
      <CopyField label="Callback URL" value={cfg.callbackUrl} />
      <p className="muted">
        Party size {cfg.partySize} · wait {cfg.waitTimeoutSec}s · on timeout:{" "}
        {cfg.onTimeout}
      </p>
    </>
  );
}
