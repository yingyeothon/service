import { Button, Table, Text, Title } from "@mantine/core";
import { api } from "../api";
import { useAuth } from "../auth";
import { Badge, Confirm, Notice, Spinner } from "../components/ui";
import { fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";
import type { Role } from "../types";

const TONE: Record<Role, string> = {
  admin: "accent",
  member: "ok",
  pending: "warn",
};

export function MembersPage() {
  const { me } = useAuth();
  const list = useApiQuery(["members"], () => api.members());
  const act = useAction();
  const go = async (id: string, action: "approve" | "promote" | "demote") => {
    await act.run(() => api.memberAction(id, action));
    await list.reload();
  };
  const pending = list.data?.filter((m) => m.role === "pending") ?? [];
  return (
    <>
      <Title order={2} mb="sm">
        Members
      </Title>
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
        <Table.ScrollContainer minWidth={640}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Login</Table.Th>
                <Table.Th>Role</Table.Th>
                <Table.Th>Signed up</Table.Th>
                <Table.Th>Approved</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.data?.map((m) => (
                <Table.Tr key={m.id}>
                  <Table.Td>
                    {m.login}
                    {m.id === me?.id && (
                      <Text span size="sm" c="dimmed">
                        {" "}
                        (you)
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Badge tone={TONE[m.role]}>{m.role}</Badge>
                  </Table.Td>
                  <Table.Td>{fmtTime(m.createdAt)}</Table.Td>
                  <Table.Td>{fmtTime(m.approvedAt)}</Table.Td>
                  <Table.Td>
                    {m.role === "pending" && (
                      <Button
                        size="compact-sm"
                        disabled={act.busy}
                        onClick={() => void go(m.id, "approve")}
                      >
                        Approve
                      </Button>
                    )}
                    {m.role === "member" && (
                      <Confirm
                        label="Promote to admin"
                        color="brand"
                        variant="default"
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
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </>
  );
}
