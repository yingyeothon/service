import { Anchor, Table, Text } from "@mantine/core";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api";
import { hasRole, useAuth } from "../auth";
import { DataTable, NameCell } from "../components/DataTable";
import { FilterBar, TextFilter } from "../components/FilterBar";
import { EventForm } from "../components/EventForm";
import { PageHeader } from "../components/PageHeader";
import { ResourceDrawer } from "../components/ResourceDrawer";
import { Badge, Notice } from "../components/ui";
import { emptyEventForm } from "../lib/eventForm";
import { fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { noMatch, useListQuery } from "../lib/listQuery";
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
  const lq = useListQuery();
  const list = useApiQuery(
    ["events", me?.id ?? null, lq.params],
    () => api.events(lq.params),
    { keepPrevious: true },
  );
  const act = useAction();
  const [creating, setCreating] = useState(false);

  const create = async (input: EventInput | Partial<EventInput>) => {
    const r = await act.run(() => api.createEvent(input as EventInput));
    if (!r) return;
    setCreating(false);
    notify.created("draft");
    void nav(`/events/${encodeURIComponent(r.id)}`);
  };

  return (
    <>
      <PageHeader
        title="Hackathon events"
        description={
          !loading && !me ? (
            <>
              Only scheduled and past events are listed.{" "}
              <Anchor href={api.loginUrl("/events")}>Sign in</Anchor> to see
              votes in progress and take part.
            </>
          ) : (
            "A date vote first, then the page every participant reads; edits are kept as revisions."
          )
        }
        actions={
          hasRole(me, "member")
            ? [
                {
                  label: "New event",
                  primary: true,
                  onClick: () => setCreating(true),
                },
              ]
            : []
        }
      />
      {act.error && !creating && <Notice kind="error">{act.error}</Notice>}
      <FilterBar>
        <TextFilter value={lq.q} onChange={lq.setQ} placeholder="Title" />
      </FilterBar>
      <DataTable
        columns={[
          { key: "title", label: "Title", sortKey: "title" },
          { key: "status", label: "Status", sortKey: "status" },
          {
            key: "when",
            label: "When",
            sortKey: "startsAt",
            defaultOrder: "desc",
          },
          { key: "place", label: "Place", sortKey: "place" },
          { key: "owner", label: "Owner", sortKey: "createdBy" },
        ]}
        rows={list.data}
        loading={list.loading}
        fetching={list.fetching}
        error={list.error}
        sort={lq.sort}
        onSort={lq.setSort}
        rowKey={(ev) => ev.id}
        minWidth={640}
        empty={
          lq.filtering ? noMatch(lq.params.q ?? "") : { title: "No events." }
        }
        render={(ev) => (
          <>
            <NameCell
              to={`/events/${encodeURIComponent(ev.id)}`}
              after={
                ev.hasPoster && (
                  <Text span size="sm" c="dimmed">
                    {" "}
                    · poster
                  </Text>
                )
              }
            >
              {ev.title}
            </NameCell>
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
          </>
        )}
      />
      <ResourceDrawer
        opened={creating}
        onClose={() => setCreating(false)}
        title="New event"
        size="lg"
        plain
      >
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
      </ResourceDrawer>
    </>
  );
}
