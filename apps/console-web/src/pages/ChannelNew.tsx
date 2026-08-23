import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api";
import { ChannelForm } from "../components/ChannelForm";
import { Notice } from "../components/ui";
import { buildConfig, emptyForm } from "../lib/channelForm";
import { errorMessage } from "../lib/format";
import { useAction, useAsync } from "../lib/useAsync";
import type { ChannelKind } from "../types";

export function ChannelNewPage() {
  const nav = useNavigate();
  const [kind, setKind] = useState<ChannelKind>("auth");
  const [form, setForm] = useState(emptyForm);
  const auths = useAsync(() => api.channels({ kind: "auth" }), []);
  const act = useAction();
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let config: unknown;
    try {
      config = buildConfig(kind, form, "create");
      setLocalError(null);
    } catch (err) {
      setLocalError(errorMessage(err));
      return;
    }
    const created = await act.run(() =>
      api.createChannel({ kind, name: form.name.trim(), config }),
    );
    if (!created) return;
    // The secret is only in this response: hand it to the detail page via
    // navigation state so it is shown once and never refetched.
    void nav(`/channels/${encodeURIComponent(created.id)}`, {
      state: { shown: created.secret ?? created.apiKey },
    });
  };

  const needsAuth = kind !== "auth" && auths.data?.length === 0;
  return (
    <>
      <h1>New channel</h1>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <label className="field">
          Kind
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ChannelKind)}
          >
            <option value="auth">
              auth — issues JWTs to players (GitHub/Google login)
            </option>
            <option value="topic">
              topic — broadcast topics over WebSocket
            </option>
            <option value="match">match — WebSocket matchmaker</option>
          </select>
        </label>
        {needsAuth && (
          <Notice kind="warn">
            topic/match channels need an auth channel you own.{" "}
            <Link to="/channels/new">Create an auth channel</Link> first.
          </Notice>
        )}
        <ChannelForm
          kind={kind}
          form={form}
          onChange={setForm}
          authChannels={auths.data ?? []}
        />
        {(localError ?? act.error) && (
          <Notice kind="error">{localError ?? act.error}</Notice>
        )}
        <div className="row">
          <button className="btn btn-primary" disabled={act.busy || needsAuth}>
            Create
          </button>
          <Link className="btn" to="/channels">
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
