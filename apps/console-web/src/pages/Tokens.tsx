import { useState, type FormEvent } from "react";
import { api } from "../api";
import { Confirm, Notice, SecretOnce, Spinner } from "../components/ui";
import { fmtTime } from "../lib/format";
import { useAction, useAsync } from "../lib/useAsync";

export function TokensPage() {
  const list = useAsync(() => api.tokens(), []);
  const act = useAction();
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(
    null,
  );

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() => api.createToken(name));
    if (!r) return;
    setFresh({ name: r.name, token: r.token });
    setName("");
    await list.reload();
  };
  const revoke = async (id: string) => {
    await act.run(() => api.revokeToken(id));
    await list.reload();
  };

  return (
    <>
      <h1>API tokens</h1>
      <p className="muted">
        Tokens authenticate the CLI:{" "}
        <code>yyt login --api {window.location.origin} --token yyt_…</code>.
        They carry your current role; revoke any you no longer use (max 20).
      </p>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {fresh && (
        <SecretOnce
          label={`Token "${fresh.name}"`}
          value={fresh.token}
          onDismiss={() => setFresh(null)}
        />
      )}
      <form className="row" onSubmit={(e) => void create(e)}>
        <input
          aria-label="Token name"
          placeholder="name (e.g. laptop)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={100}
        />
        <button className="btn btn-primary" disabled={act.busy || !name.trim()}>
          Create token
        </button>
      </form>
      <h2>Existing</h2>
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Id</th>
              <th>Created</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>
                  <code>{t.id}</code>
                </td>
                <td>{fmtTime(t.createdAt)}</td>
                <td>{fmtTime(t.lastUsedAt)}</td>
                <td>
                  <Confirm
                    label="Revoke"
                    onConfirm={() => revoke(t.id)}
                    disabled={act.busy}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No tokens yet.</p>
      )}
    </>
  );
}
