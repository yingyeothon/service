import {
  Anchor,
  Button,
  Code,
  Group,
  NativeSelect,
  Table,
  Tabs,
  Text,
  TextInput,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api";
import { useCursorList } from "../lib/cursor";
import { useApiQuery } from "../lib/query";
import { fmtBytes, fmtStamp, plain, tracerRead } from "../lib/tracer";
import type {
  TracerEventQuery,
  TracerEventRow,
  TracerLog,
  TracerLogQuery,
} from "../types";
import { Clipped } from "./Clipped";
import { DataTable, NumCell } from "./DataTable";
import { EnumFilter, FilterBar } from "./FilterBar";
import { Badge } from "./ui";

/*
 * What a tracer resource holds (docs/decisions.md *Debug collector
 * (`tracer`)* #12): issues, events, logs, drops and usage, read straight from
 * tracer with a console read ticket (`api.tracer*`). The tab and its filters
 * live in the URL, so an issue's "events" link and the browser's back button
 * both work. Every device string is plain text (`lib/tracer.ts`).
 */

export const tracerEventUrl = (id: string, eventId: string) =>
  `/tracers/${encodeURIComponent(id)}/events/${encodeURIComponent(eventId)}`;

const TABS = ["issues", "events", "logs", "usage"] as const;
type Tab = (typeof TABS)[number];

const SINCE = [
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

const LEVELS = ["", "trace", "debug", "info", "warning", "error", "fatal"];

/** A level as a badge: the tone carries the severity, the text says it. */
export function LevelBadge({ level }: { level?: string }) {
  if (!level) return <>—</>;
  const tone =
    level === "error" || level === "fatal"
      ? "danger"
      : level === "warning" || level === "warn"
        ? "warn"
        : "neutral";
  return <Badge tone={tone}>{plain(level, 16)}</Badge>;
}

/** Only the filters a value is set for: a stable key and a clean URL. */
function setOnly<T extends object>(q: T): T {
  return Object.fromEntries(
    Object.entries(q).filter(([, v]) => v !== undefined && v !== ""),
  ) as T;
}

export function TracerData({ id }: { id: string }) {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab") ?? "issues";
  const tab: Tab = (TABS as readonly string[]).includes(raw)
    ? (raw as Tab)
    : "issues";
  /** Replace some query parameters; empty values are dropped. */
  const update = (next: Record<string, string | undefined>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next))
      if (v) p.set(k, v);
      else p.delete(k);
    setParams(p, { replace: true });
  };
  return (
    <Tabs
      value={tab}
      onChange={(v) => {
        // A tab switch starts from that tab's defaults.
        setParams(v && v !== "issues" ? { tab: v } : {}, { replace: true });
      }}
      keepMounted={false}
    >
      <Tabs.List>
        <Tabs.Tab value="issues">Issues</Tabs.Tab>
        <Tabs.Tab value="events">Events</Tabs.Tab>
        <Tabs.Tab value="logs">Logs</Tabs.Tab>
        <Tabs.Tab value="usage">Drops and usage</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="issues" pt="md">
        <IssuesTab
          id={id}
          since={params.get("since") ?? "7d"}
          onSince={(since) => update({ since })}
          onGroup={(group) => setParams({ tab: "events", group, since: "30d" })}
        />
      </Tabs.Panel>
      <Tabs.Panel value="events" pt="md">
        <EventsTab id={id} params={params} update={update} />
      </Tabs.Panel>
      <Tabs.Panel value="logs" pt="md">
        <LogsTab id={id} params={params} update={update} />
      </Tabs.Panel>
      <Tabs.Panel value="usage" pt="md">
        <UsageTab id={id} />
      </Tabs.Panel>
    </Tabs>
  );
}

function IssuesTab({
  id,
  since,
  onSince,
  onGroup,
}: {
  id: string;
  since: string;
  onSince: (v: string) => void;
  onGroup: (groupKey: string) => void;
}) {
  const q = useApiQuery(
    ["tracer", id, "issues", since],
    () => tracerRead(api.tracerIssues(id, { since })),
    { keepPrevious: true },
  );
  return (
    <>
      <FilterBar>
        <EnumFilter
          label="Last seen within"
          value={since}
          options={SINCE}
          onChange={onSince}
        />
      </FilterBar>
      <DataTable
        columns={[
          { key: "title", label: "Issue" },
          { key: "level", label: "Level" },
          { key: "count", label: "Events", align: "right" },
          { key: "last", label: "Last seen" },
          { key: "latest", label: "Latest" },
        ]}
        rows={q.data}
        loading={q.loading}
        fetching={q.fetching}
        error={q.error}
        rowKey={(i) => i.groupKey}
        minWidth={0}
        empty={{ title: "No issues in this window." }}
        render={(i) => (
          <>
            <Table.Td>
              <Anchor
                component="button"
                type="button"
                fz="sm"
                onClick={() => onGroup(i.groupKey)}
                aria-label={`${plain(i.title, 200) || "(untitled)"}, last seen ${fmtStamp(i.lastSeen)}: events`}
                style={{
                  display: "block",
                  width: "16rem",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  textAlign: "left",
                }}
              >
                {plain(i.title, 200) || "(untitled)"}
              </Anchor>
            </Table.Td>
            <Table.Td>
              <LevelBadge level={i.level} />
            </Table.Td>
            <NumCell>{i.count}</NumCell>
            <Table.Td style={{ whiteSpace: "nowrap" }}>
              {fmtStamp(i.lastSeen)}
            </Table.Td>
            <Table.Td>
              <Anchor
                component={Link}
                to={tracerEventUrl(id, i.latestEventId)}
                fz="sm"
                aria-label={`Open latest event: ${plain(i.title, 200)}, last seen ${fmtStamp(i.lastSeen)}`}
              >
                Open
              </Anchor>
            </Table.Td>
          </>
        )}
      />
    </>
  );
}

/** A free-text filter that writes to the URL once typing pauses. */
function UrlText({
  label,
  name,
  params,
  update,
  placeholder,
  w = 160,
}: {
  label: string;
  name: string;
  params: URLSearchParams;
  update: (next: Record<string, string | undefined>) => void;
  placeholder?: string;
  w?: number;
}) {
  return (
    <CommitInput
      key={params.get(name) ?? ""}
      label={label}
      initial={params.get(name) ?? ""}
      onCommit={(v) => update({ [name]: v.trim() || undefined })}
      placeholder={placeholder}
      w={w}
    />
  );
}

function CommitInput({
  label,
  initial,
  onCommit,
  placeholder,
  w,
}: {
  label: string;
  initial: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  w: number;
}) {
  // Applies on change like every list filter, after typing pauses.
  const [value, setValue] = useState(initial);
  const [settled] = useDebouncedValue(value, 400);
  useEffect(() => {
    if (settled !== initial) onCommit(settled);
    // `initial` is the URL's value: once committed, the input is re-keyed.
  }, [settled]);
  return (
    <TextInput
      label={label}
      value={value}
      placeholder={placeholder}
      w={w}
      autoComplete="off"
      spellCheck={false}
      onChange={(e) => setValue(e.currentTarget.value)}
    />
  );
}

function EventsTab({
  id,
  params,
  update,
}: {
  id: string;
  params: URLSearchParams;
  update: (next: Record<string, string | undefined>) => void;
}) {
  const query: TracerEventQuery = setOnly({
    since: params.get("since") ?? "24h",
    release: params.get("release") ?? undefined,
    device: params.get("device") ?? undefined,
    group: params.get("group") ?? undefined,
  });
  const list = useCursorList(
    ["tracer", id, "events", query],
    (cursor) => tracerRead(api.tracerEvents(id, setOnly({ ...query, cursor }))),
    (p) => p.rows,
    { keepPrevious: true },
  );
  return (
    <>
      <FilterBar>
        <EnumFilter
          label="Received within"
          value={query.since ?? "24h"}
          options={SINCE}
          onChange={(since) => update({ since })}
        />
        <UrlText
          label="Release"
          name="release"
          params={params}
          update={update}
        />
        <UrlText label="Device" name="device" params={params} update={update} />
      </FilterBar>
      {query.group && (
        <Group gap="xs" mb="sm">
          <Text size="sm">
            One issue only: <Code>{plain(query.group, 64)}</Code>
          </Text>
          <Button
            variant="default"
            size="xs"
            onClick={() => update({ group: undefined })}
          >
            Show every issue
          </Button>
        </Group>
      )}
      <DataTable<TracerEventRow>
        columns={[
          { key: "title", label: "Event" },
          { key: "type", label: "Type" },
          { key: "level", label: "Level" },
          { key: "device", label: "Device" },
          { key: "received", label: "Received" },
        ]}
        rows={list.rows}
        loading={list.loading}
        fetching={list.fetching}
        error={list.error}
        rowKey={(e) => e.eventId}
        minWidth={0}
        empty={{ title: "No events match." }}
        render={(e) => (
          <>
            <Table.Td>
              <Anchor
                component={Link}
                to={tracerEventUrl(id, e.eventId)}
                fz="sm"
                aria-label={`${plain(e.title ?? "", 200) || e.eventId}, received ${fmtStamp(e.received)}`}
                style={{
                  display: "block",
                  width: "12rem",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {plain(e.title ?? "", 200) || e.eventId}
              </Anchor>
            </Table.Td>
            <Table.Td>{plain(e.type, 24)}</Table.Td>
            <Table.Td>
              <LevelBadge level={e.level} />
            </Table.Td>
            <Table.Td>
              {e.device ? (
                <Clipped
                  text={plain(e.device, 200)}
                  width={110}
                  what="Full device"
                />
              ) : (
                "—"
              )}
            </Table.Td>
            <Table.Td style={{ whiteSpace: "nowrap" }}>
              {fmtStamp(e.received)}
            </Table.Td>
          </>
        )}
      />
      <LoadMore
        next={list.next}
        busy={list.busy || list.fetching}
        onMore={list.loadMore}
      />
    </>
  );
}

function LoadMore({
  next,
  busy,
  onMore,
}: {
  next: string | null;
  busy: boolean;
  onMore: () => Promise<void>;
}) {
  if (!next) return null;
  return (
    <Group justify="center" mt="sm">
      <Button
        variant="default"
        loading={busy}
        disabled={busy}
        onClick={() => void onMore()}
      >
        Load more
      </Button>
    </Group>
  );
}

function LogsTab({
  id,
  params,
  update,
}: {
  id: string;
  params: URLSearchParams;
  update: (next: Record<string, string | undefined>) => void;
}) {
  const query: TracerLogQuery = setOnly({
    since: params.get("since") ?? "1h",
    until: params.get("until") ?? undefined,
    level: params.get("level") ?? undefined,
    text: params.get("text") ?? undefined,
    device: params.get("device") ?? undefined,
    attr: params.get("attr") ?? undefined,
  });
  const list = useCursorList(
    ["tracer", id, "logs", query],
    (cursor) => tracerRead(api.tracerLogs(id, setOnly({ ...query, cursor }))),
    (p) => p.rows,
    { keepPrevious: true },
  );
  return (
    <>
      <FilterBar>
        <UrlText
          label="Since"
          name="since"
          params={params}
          update={update}
          placeholder="1h (default), 7d or RFC 3339"
          w={150}
        />
        <UrlText
          label="Until"
          name="until"
          params={params}
          update={update}
          w={150}
        />
        <NativeSelect
          label="Level"
          value={query.level ?? ""}
          data={LEVELS.map((l) => ({ value: l, label: l || "any" }))}
          onChange={(e) =>
            update({ level: e.currentTarget.value || undefined })
          }
        />
        <UrlText label="Text" name="text" params={params} update={update} />
        <UrlText
          label="Device"
          name="device"
          params={params}
          update={update}
          w={140}
        />
        <UrlText
          label="Attribute"
          name="attr"
          params={params}
          update={update}
          placeholder="key:value"
          w={150}
        />
      </FilterBar>
      <DataTable<TracerLog>
        columns={[
          { key: "time", label: "Received" },
          { key: "level", label: "Level" },
          { key: "body", label: "Message" },
          { key: "device", label: "Device" },
        ]}
        rows={list.rows}
        loading={list.loading}
        fetching={list.fetching}
        error={list.error}
        // Logs have no id and one envelope shares a receive time: the
        // position is the key (pages only ever append).
        rowKey={(l) => String(list.rows?.indexOf(l) ?? 0)}
        minWidth={0}
        empty={{ title: "No logs match." }}
        render={(l) => (
          <>
            <Table.Td style={{ whiteSpace: "nowrap" }}>
              {fmtStamp(l.received)}
            </Table.Td>
            <Table.Td>
              <LevelBadge level={l.level} />
            </Table.Td>
            <Table.Td>
              <Clipped
                text={plain(l.body ?? "", 4000)}
                width={300}
                what="Full message"
              />
            </Table.Td>
            <Table.Td>
              {l.device ? (
                <Clipped
                  text={plain(l.device, 200)}
                  width={100}
                  what="Full device"
                />
              ) : (
                "—"
              )}
            </Table.Td>
          </>
        )}
      />
      <LoadMore
        next={list.next}
        busy={list.busy || list.fetching}
        onMore={list.loadMore}
      />
    </>
  );
}

function UsageTab({ id }: { id: string }) {
  const usage = useApiQuery(["tracer", id, "usage"], () =>
    tracerRead(api.tracerUsage(id)),
  );
  const drops = useApiQuery(["tracer", id, "drops"], () =>
    tracerRead(api.tracerDrops(id)),
  );
  return (
    <>
      <Text size="sm" fw={600} mb={4}>
        Stored per UTC day
      </Text>
      <DataTable
        columns={[
          { key: "day", label: "Day" },
          { key: "bytes", label: "Stored", align: "right" },
          { key: "quota", label: "Quota reached" },
        ]}
        rows={usage.data}
        loading={usage.loading}
        error={usage.error}
        rowKey={(u) => u.day}
        minWidth={0}
        empty={{ title: "Nothing stored in the last 7 days." }}
        render={(u) => (
          <>
            <Table.Td>{u.day}</Table.Td>
            <NumCell>{fmtBytes(u.bytes)}</NumCell>
            <Table.Td>{u.quotaHit ? fmtStamp(u.quotaHit) : "—"}</Table.Td>
          </>
        )}
      />
      <Text size="sm" fw={600} mt="md" mb={4}>
        Dropped and refused
      </Text>
      <DataTable
        columns={[
          { key: "day", label: "Day" },
          { key: "item", label: "Item" },
          { key: "reason", label: "Reason" },
          { key: "count", label: "Count", align: "right" },
          { key: "bytes", label: "Bytes", align: "right" },
        ]}
        rows={drops.data}
        loading={drops.loading}
        error={drops.error}
        rowKey={(d) => `${d.day}|${d.itemType}|${d.reason}`}
        minWidth={0}
        empty={{ title: "Nothing dropped in the last 7 days." }}
        render={(d) => (
          <>
            <Table.Td>{d.day}</Table.Td>
            <Table.Td>{plain(d.itemType, 40)}</Table.Td>
            <Table.Td>{plain(d.reason, 40)}</Table.Td>
            <NumCell>{d.count}</NumCell>
            <NumCell>{fmtBytes(d.bytes)}</NumCell>
          </>
        )}
      />
    </>
  );
}
