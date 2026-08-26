import {
  Anchor,
  Button,
  Card,
  Group,
  NativeSelect,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { Badge, Notice, Spinner } from "../components/ui";
import { fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";
import { STANDING_TONE, teamUrl } from "../lib/team";
import type { RotationHint } from "../types";

/** What `DELETE /teams/{id}/members/{me}` hands back when a member leaves. */
export interface LeftState {
  left: string;
  rotate: RotationHint[];
}

export function RotationNotice({
  rotate,
  who,
}: {
  rotate: RotationHint[];
  who: string;
}) {
  if (rotate.length === 0) return null;
  return (
    <Notice kind="warn">
      <Text size="sm">
        {who} still knows the credentials of these channels — nothing was
        revoked, because a rotation mid-game kills it. Rotate them when it is
        safe:
      </Text>
      <Text size="sm">
        {rotate.map((c, i) => (
          <span key={c.id}>
            {i > 0 && ", "}
            <Anchor
              component={Link}
              to={`/channels/${encodeURIComponent(c.id)}`}
              size="sm"
            >
              {c.name}
            </Anchor>{" "}
            ({c.kind})
          </span>
        ))}
      </Text>
    </Notice>
  );
}

export function TeamsPage() {
  const { me } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [all, setAll] = useState(false);
  const list = useApiQuery(["teams", all], () =>
    api.teams(all ? "all" : undefined),
  );
  const act = useAction();
  const [name, setName] = useState("");
  const [joinName, setJoinName] = useState("");
  const [joined, setJoined] = useState<string | null>(null);
  // Captured once: the history entry is scrubbed right after, so a reload or
  // back/forward never resurrects the rotation list.
  const [left] = useState<LeftState | null>(
    () => (loc.state as LeftState | null) ?? null,
  );
  useEffect(() => {
    if ((loc.state as LeftState | null)?.left)
      void nav(loc.pathname, { replace: true, state: null });
  }, [loc.state, loc.pathname, nav]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() => api.createTeam({ name: name.trim() }));
    if (!r) return;
    setName("");
    void nav(teamUrl(r.id));
  };
  const join = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() => api.joinTeam(joinName.trim()));
    if (!r) return;
    setJoined(r.name);
    setJoinName("");
    await list.reload();
  };

  return (
    <>
      <Title order={2} mb="sm">
        Teams
      </Title>
      <Text size="sm" c="dimmed" mb="sm">
        A team owns projects; a project owns channels, catalog apps and asset
        bundles. Every member of a team may read and write all of it. There is
        no public list of teams: ask an owner to add you, or request to join by
        the exact name.
      </Text>
      {left && (
        <>
          <Notice kind="success">You left {left.left}.</Notice>
          <RotationNotice rotate={left.rotate} who="You" />
        </>
      )}
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {joined && (
        <Notice kind="success">
          Requested to join <strong>{joined}</strong>. An owner has to approve
          it.
        </Notice>
      )}

      <Card withBorder mb="md" padding="sm">
        <form onSubmit={(e) => void create(e)}>
          <Group align="end" wrap="wrap">
            <TextInput
              label="New team"
              placeholder="name (e.g. my-studio)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={64}
            />
            <Button type="submit" disabled={act.busy || !name.trim()}>
              Create team
            </Button>
          </Group>
        </form>
        <form onSubmit={(e) => void join(e)}>
          <Group align="end" wrap="wrap" mt="xs">
            <TextInput
              label="Request to join"
              placeholder="exact team name"
              value={joinName}
              onChange={(e) => setJoinName(e.target.value)}
              required
              maxLength={64}
            />
            <Button
              type="submit"
              variant="default"
              disabled={act.busy || !joinName.trim()}
            >
              Request
            </Button>
          </Group>
        </form>
      </Card>

      {me?.role === "admin" && (
        <Group mb="md">
          <NativeSelect
            label="Scope"
            value={all ? "all" : "mine"}
            onChange={(e) => setAll(e.target.value === "all")}
            data={[
              { value: "mine", label: "mine" },
              { value: "all", label: "every team (admin)" },
            ]}
          />
        </Group>
      )}
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <Table.ScrollContainer minWidth={480}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Team</Table.Th>
                <Table.Th>Your role</Table.Th>
                <Table.Th>Created by</Table.Th>
                <Table.Th>Updated</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.data.map((t) => (
                <Table.Tr key={t.id}>
                  <Table.Td>
                    <Anchor component={Link} to={teamUrl(t.id)} size="sm">
                      {t.name}
                    </Anchor>{" "}
                    {t.adminLocked && <Badge tone="danger">admin-locked</Badge>}
                  </Table.Td>
                  <Table.Td>
                    <Badge tone={STANDING_TONE[t.role]}>{t.role}</Badge>
                  </Table.Td>
                  <Table.Td>{t.createdBy ?? "—"}</Table.Td>
                  <Table.Td>{fmtTime(t.updatedAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <Text size="sm" c="dimmed">
          You are not in any team yet.
        </Text>
      )}
    </>
  );
}
