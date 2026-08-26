import {
  Button,
  Card,
  Group,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { Badge, Confirm, Notice, Spinner } from "../components/ui";
import { fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";
import { teamUrl } from "../lib/team";
import type { Role } from "../types";

/**
 * Which catalog app `GET /catalog/installer/downloads` serves. Its team must
 * be admin-locked, or every member of that team could push the APK every
 * device self-updates to.
 */
export function InstallerAppCard() {
  const setting = useApiQuery(["admin", "installer-app"], () =>
    api.installerApp(),
  );
  const act = useAction();
  const [appId, setAppId] = useState("");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() => api.setInstallerApp(appId.trim() || null));
    if (!r) return;
    setting.set(r);
    setAppId("");
  };
  const s = setting.data;
  return (
    <Card withBorder mb="md" padding="sm">
      <Text size="sm" fw={600} mb={4}>
        Installer app
      </Text>
      {setting.error && <Notice kind="error">{setting.error}</Notice>}
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {s && (
        <Text size="sm" mb="xs">
          {s.appId ? (
            <>
              <strong>{s.appName ?? s.appId}</strong> (<code>{s.appId}</code>)
              in{" "}
              {s.teamId ? (
                <Link to={teamUrl(s.teamId)}>{s.teamName ?? s.teamId}</Link>
              ) : (
                "no team"
              )}{" "}
              ·{" "}
              {s.trusted ? (
                <Badge tone="ok">trusted</Badge>
              ) : (
                <Badge tone="danger">untrusted — downloads answer 503</Badge>
              )}
            </>
          ) : (
            "Not set: the downloads route answers 503."
          )}
        </Text>
      )}
      <form onSubmit={(e) => void save(e)}>
        <Group align="end" wrap="wrap">
          <TextInput
            label="Catalog app id"
            placeholder="ca_…"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            maxLength={64}
          />
          <Button type="submit" disabled={act.busy || !appId.trim()}>
            Set
          </Button>
          {s?.appId && (
            <Confirm
              label="Clear"
              onConfirm={async () => {
                const r = await act.run(() => api.setInstallerApp(null));
                if (r) setting.set(r);
              }}
              disabled={act.busy}
            />
          )}
        </Group>
      </form>
    </Card>
  );
}

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
      <InstallerAppCard />
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
