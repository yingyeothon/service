import { api } from "../api";
import { useAuth } from "../auth";
import { Badge, Confirm, Notice, Spinner } from "../components/ui";
import { fmtTime } from "../lib/format";
import { useAction, useAsync } from "../lib/useAsync";
import type { Role } from "../types";

const TONE: Record<Role, string> = {
  admin: "accent",
  member: "ok",
  pending: "warn",
};

export function MembersPage() {
  const { me } = useAuth();
  const list = useAsync(() => api.members(), []);
  const act = useAction();
  const go = async (id: string, action: "approve" | "promote" | "demote") => {
    await act.run(() => api.memberAction(id, action));
    await list.reload();
  };
  const pending = list.data?.filter((m) => m.role === "pending") ?? [];
  return (
    <>
      <h1>Members</h1>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {pending.length > 0 && (
        <Notice kind="warn">
          {pending.length} sign-up{pending.length > 1 ? "s" : ""} waiting for
          approval.
        </Notice>
      )}
      {list.loading && !list.data ? (
        <Spinner />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Login</th>
              <th>Role</th>
              <th>Signed up</th>
              <th>Approved</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data?.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.login}
                  {m.id === me?.id && <span className="muted"> (you)</span>}
                </td>
                <td>
                  <Badge tone={TONE[m.role]}>{m.role}</Badge>
                </td>
                <td>{fmtTime(m.createdAt)}</td>
                <td>{fmtTime(m.approvedAt)}</td>
                <td className="row">
                  {m.role === "pending" && (
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={act.busy}
                      onClick={() => void go(m.id, "approve")}
                    >
                      Approve
                    </button>
                  )}
                  {m.role === "member" && (
                    <Confirm
                      label="Promote to admin"
                      className="btn btn-sm"
                      onConfirm={() => go(m.id, "promote")}
                      disabled={act.busy}
                    />
                  )}
                  {m.role === "admin" && m.id !== me?.id && (
                    <Confirm
                      label="Demote"
                      onConfirm={() => go(m.id, "demote")}
                      disabled={act.busy}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
