import { Anchor, Button, Group, Table, Text, Title } from "@mantine/core";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api";
import { hasRole, useAuth } from "../auth";
import { EventForm } from "../components/EventForm";
import { Badge, Notice, Spinner } from "../components/ui";
import { emptyEventForm } from "../lib/eventForm";
import { fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";
import type { EventInput, EventStatus } from "../types";

export const STATUS_TONE: Record<EventStatus, string> = {
  draft: "neutral",
  voting: "accent",
  waiting: "warn",
  opened: "ok",
  closed: "neutral",
  cancelled: "danger",
};

export function EventsPage() {
  const { me, loading } = useAuth();
  const nav = useNavigate();
  const list = useApiQuery(["events", me?.id ?? null], () => api.events());
  const act = useAction();
  const [creating, setCreating] = useState(false);

  const create = async (input: EventInput | Partial<EventInput>) => {
    const r = await act.run(() => api.createEvent(input as EventInput));
    if (!r) return;
    setCreating(false);
    void nav(`/events/${encodeURIComponent(r.id)}`);
  };

  return (
    <>
      <Group justify="space-between" mb="sm">
        <Title order={2}>Hackathon events</Title>
        {hasRole(me, "member") && !creating && (
          <Button onClick={() => setCreating(true)}>New event</Button>
        )}
      </Group>
      {!loading && !me && (
        <Text size="sm" c="dimmed" mb="sm">
          Only scheduled and past events are listed.{" "}
          <Anchor href={api.loginUrl("/events")}>Sign in</Anchor> to see votes
          in progress and take part.
        </Text>
      )}
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {creating && (
        <EventForm
          initial={emptyEventForm()}
          schedule
          busy={act.busy}
          submitLabel="Create draft"
          onSubmit={create}
          onCancel={() => setCreating(false)}
        />
      )}
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Title</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>When</Table.Th>
              <Table.Th>Place</Table.Th>
              <Table.Th>Owner</Table.Th>
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
                <Table.Td>
                  {ev.startsAt !== null
                    ? `${fmtTime(ev.startsAt)} · ${ev.durationHours}h`
                    : ev.status === "voting"
                      ? `vote until ${fmtTime(ev.voteUntil)}`
                      : "—"}
                </Table.Td>
                <Table.Td>{ev.place}</Table.Td>
                <Table.Td>{ev.owner ?? "—"}</Table.Td>
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
