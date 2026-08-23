import {
  Anchor,
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
import { hasRole, useAuth } from "../auth";
import { Badge, Notice, Spinner } from "../components/ui";
import { fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";
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
  const list = useApiQuery(["events", me?.id ?? null], () => api.events());
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
      <Group justify="space-between" mb="sm">
        <Title order={2}>Hackathon events</Title>
        {hasRole(me, "admin") && (
          <Button onClick={() => setCreating((v) => !v)}>New event</Button>
        )}
      </Group>
      {!loading && !me && (
        <Text size="sm" c="dimmed" mb="sm">
          Only published events are listed.{" "}
          <Anchor href={api.loginUrl("/events")}>Sign in</Anchor> to see events
          in progress and take part.
        </Text>
      )}
      {creating && (
        <Card withBorder mb="md">
          <form onSubmit={(e) => void create(e)}>
            <Group align="end">
              <TextInput
                aria-label="Event title"
                placeholder="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                maxLength={200}
              />
              <Button type="submit" disabled={act.busy || !title.trim()}>
                Create draft
              </Button>
            </Group>
          </form>
        </Card>
      )}
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Title</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Updated</Table.Th>
              <Table.Th>Published</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {list.data.map((ev) => (
              <Table.Tr key={ev.id}>
                <Table.Td>
                  <Anchor
                    component={Link}
                    to={`/events/${encodeURIComponent(ev.id)}`}
                  >
                    {ev.title}
                  </Anchor>
                  {ev.hasPoster && (
                    <Text span size="sm" c="dimmed">
                      {" "}
                      · poster
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Badge tone={STATUS_TONE[ev.status]}>{ev.status}</Badge>
                </Table.Td>
                <Table.Td>{fmtTime(ev.updatedAt)}</Table.Td>
                <Table.Td>{fmtTime(ev.publishedAt)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      ) : (
        <Text size="sm" c="dimmed">
          No events.
        </Text>
      )}
    </>
  );
}
