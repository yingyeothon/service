import {
  Anchor,
  Box,
  Button,
  Code,
  Group,
  Image,
  NativeSelect,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { Crumbs } from "../components/Crumbs";
import { DataTable } from "../components/DataTable";
import { JsonTree } from "../components/JsonTree";
import { PageSkeleton } from "../components/Loading";
import { PageHeader } from "../components/PageHeader";
import { Section } from "../components/Section";
import { LevelBadge } from "../components/TracerData";
import { Badge, Notice } from "../components/ui";
import { useAction, useApiQuery } from "../lib/query";
import {
  attachmentRole,
  fmtBytes,
  fmtStamp,
  plain,
  safeBlob,
  SCREENSHOT_AUTOLOAD_MAX_BYTES,
  tracerRead,
  VIEW_HIERARCHY_MAX_BYTES,
} from "../lib/tracer";
import type {
  TracerAttachment,
  TracerEventDetail,
  TracerTimelineEntry,
} from "../types";
import { tracerUrl } from "./Tracer";

/*
 * One tracer event (`/tracers/:id/events/:eventId`, decisions tracer #12):
 * what the device sent, the timeline around it (breadcrumbs, logs, feedback,
 * neighbouring events), and its attachments. Everything below came from a
 * device holding a public write key: plain text only, links `http(s)` only,
 * a screenshot shown only when its bytes are an image, every other file a
 * download that the browser never renders.
 */

const WINDOWS = ["1m", "2m", "5m", "10m", "30m"];

export function TracerEventPage() {
  const { id = "", eventId = "" } = useParams();
  const t = useApiQuery(["tracers", id], () => api.tracer(id));
  const ev = useApiQuery(["tracer", id, "event", eventId], () =>
    tracerRead(api.tracerEvent(id, eventId)),
  );
  const e = ev.data;
  const crumbs = (
    <Crumbs
      crumbs={t.data ?? {}}
      parent={
        t.data
          ? { label: t.data.name, to: `${tracerUrl(id)}?tab=events` }
          : undefined
      }
      current={e ? plain(e.title ?? e.eventId, 80) : undefined}
    />
  );
  return (
    <>
      {crumbs}
      <PageHeader
        title={
          e
            ? plain(e.title ?? "", 200) || e.eventId
            : ev.error
              ? "Event"
              : undefined
        }
        meta={
          e ? (
            <>
              {plain(e.type, 24)} · received {fmtStamp(e.received)} · id{" "}
              <Code>{e.eventId}</Code>
            </>
          ) : undefined
        }
      />
      {e ? (
        // Keyed: a related event's page never shows this one's timeline.
        <EventBody key={`${id}/${e.eventId}`} id={id} e={e} />
      ) : ev.error ? (
        <Notice kind="error">{ev.error}</Notice>
      ) : (
        <PageSkeleton />
      )}
    </>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(
    ([, v]) => v !== undefined && v !== "" && v !== null,
  );
  return (
    <Table withRowBorders={false} verticalSpacing={2} w="auto">
      <Table.Tbody>
        {shown.map(([k, v]) => (
          <Table.Tr key={k}>
            <Table.Th style={{ whiteSpace: "nowrap", fontWeight: 500 }}>
              {k}
            </Table.Th>
            <Table.Td style={{ wordBreak: "break-word" }}>{v}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

const txt = (v: string | undefined, max = 400) =>
  v ? plain(v, max) : undefined;

function EventBody({ id, e }: { id: string; e: TracerEventDetail }) {
  const sdk = e.sdk
    ? [e.sdk.name, e.sdk.version].filter(Boolean).join(" ")
    : "";
  return (
    <>
      <Section title="Summary">
        <Facts
          rows={[
            ["Level", e.level ? <LevelBadge level={e.level} /> : undefined],
            ["Message", txt(e.message, 4000)],
            ["Device time", e.timestamp ? fmtStamp(e.timestamp) : undefined],
            ["Release", txt(e.release)],
            ["Dist", txt(e.dist)],
            ["Environment", txt(e.environment)],
            ["Device", txt(e.device)],
            ["OS", txt(e.os)],
            ["Installation", txt(e.userId)],
            ["Trace", txt(e.traceId)],
            ["SDK", sdk ? plain(sdk, 200) : undefined],
            ["Platform", txt(e.platform)],
            [
              "Related event",
              e.associatedEventId ? (
                <Anchor
                  component={Link}
                  to={`${tracerUrl(id)}/events/${encodeURIComponent(e.associatedEventId)}`}
                >
                  {plain(e.associatedEventId, 64)}
                </Anchor>
              ) : undefined,
            ],
          ]}
        />
        {e.omitted && e.omitted.length > 0 && (
          <Text size="sm" c="dimmed" mt="xs">
            Left out for size: {e.omitted.map((o) => plain(o, 80)).join(", ")}
          </Text>
        )}
      </Section>
      {e.exception && e.exception.length > 0 && <Exceptions e={e} />}
      <Timeline id={id} eventId={e.eventId} />
      {e.attachments && e.attachments.length > 0 && (
        <Attachments id={id} list={e.attachments} />
      )}
      {e.tags && Object.keys(e.tags).length > 0 && (
        <Section title="Tags">
          <JsonTree value={e.tags} label="tags" />
        </Section>
      )}
      {e.contexts && Object.keys(e.contexts).length > 0 && (
        <Section
          title="Contexts"
          description="Feedback text sits under `feedback`."
        >
          <JsonTree value={e.contexts} label="contexts" openDepth={1} />
        </Section>
      )}
      {e.extra !== undefined && e.extra !== null && (
        <Section title="Extra">
          <JsonTree value={e.extra} label="extra" />
        </Section>
      )}
    </>
  );
}

function Exceptions({ e }: { e: TracerEventDetail }) {
  return (
    <Section title="Exception">
      <Stack gap="md">
        {(e.exception ?? []).map((x, i) => (
          <Box key={i}>
            <Group gap="xs" mb={4}>
              <Text fw={600} size="sm">
                {plain(x.type ?? "Error", 200)}
              </Text>
              {x.mechanism?.handled === false && (
                <Badge tone="danger">crash</Badge>
              )}
            </Group>
            {x.value && (
              <Text
                size="sm"
                mb={4}
                style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
              >
                {plain(x.value, 4000)}
              </Text>
            )}
            <Box ff="monospace" fz="xs">
              {(x.frames ?? []).map((f, k) => (
                <div key={k} style={{ opacity: f.inApp ? 1 : 0.6 }}>
                  {plain(f.function ?? "?", 300)}{" "}
                  <Text span fz="xs" c="dimmed">
                    {plain(f.filename ?? f.module ?? "", 300)}
                    {f.lineno !== undefined ? `:${f.lineno}` : ""}
                    {f.colno !== undefined ? `:${f.colno}` : ""}
                  </Text>
                </div>
              ))}
            </Box>
          </Box>
        ))}
      </Stack>
    </Section>
  );
}

function Timeline({ id, eventId }: { id: string; eventId: string }) {
  const [span, setSpan] = useState("2m");
  const q = useApiQuery(
    ["tracer", id, "timeline", eventId, span],
    () => tracerRead(api.tracerTimeline(id, eventId, span)),
    { keepPrevious: true },
  );
  return (
    <Section
      title="Timeline"
      description="Breadcrumbs, logs, feedback and neighbouring events of the same trace or installation."
      actions={
        <NativeSelect
          aria-label="Window"
          value={span}
          data={WINDOWS.map((w) => ({ value: w, label: `± ${w}` }))}
          onChange={(ev) => setSpan(ev.currentTarget.value)}
        />
      }
    >
      <DataTable<TracerTimelineEntry>
        columns={[
          { key: "time", label: "Time" },
          { key: "kind", label: "Kind" },
          { key: "what", label: "What" },
        ]}
        rows={q.data?.entries}
        loading={q.loading}
        fetching={q.fetching}
        error={q.error}
        // Identical breadcrumbs are common: the position is the key.
        rowKey={(x) => String(q.data?.entries.indexOf(x) ?? 0)}
        minWidth={0}
        empty={{ title: "Nothing around this event." }}
        render={(x) => (
          <>
            <Table.Td style={{ whiteSpace: "nowrap", verticalAlign: "top" }}>
              {fmtStamp(x.timestamp)}
            </Table.Td>
            <Table.Td style={{ verticalAlign: "top" }}>
              <Badge
                tone={
                  x.kind === "feedback"
                    ? "warn"
                    : x.eventId === eventId
                      ? "danger"
                      : "neutral"
                }
              >
                {plain(x.kind, 16)}
              </Badge>
            </Table.Td>
            <Table.Td style={{ wordBreak: "break-word" }}>
              <TimelineWhat id={id} x={x} self={eventId} />
            </Table.Td>
          </>
        )}
      />
      {q.data?.truncated && (
        <Text size="sm" c="dimmed" mt="xs">
          Some sources hit their limit; narrow the window to see all of it.
        </Text>
      )}
    </Section>
  );
}

function TimelineWhat({
  id,
  x,
  self,
}: {
  id: string;
  x: TracerTimelineEntry;
  self: string;
}) {
  const head = [x.level, x.category ?? x.type].filter(Boolean).join(" · ");
  const data = x.data ?? x.attributes;
  return (
    <>
      {head && (
        <Text span size="xs" c="dimmed" mr={6}>
          {plain(head, 120)}
        </Text>
      )}
      <Text span size="sm" style={{ whiteSpace: "pre-wrap" }}>
        {plain(x.message ?? "", 2000)}
      </Text>
      {x.eventId && x.eventId !== self && (
        <Anchor
          component={Link}
          to={`${tracerUrl(id)}/events/${encodeURIComponent(x.eventId)}`}
          aria-label={`Open event ${x.eventId}`}
          size="sm"
          ml={6}
        >
          Open event
        </Anchor>
      )}
      {data !== undefined && data !== null && (
        <JsonTree value={data} label="data" openDepth={0} maxNodes={300} />
      )}
    </>
  );
}

function Attachments({ id, list }: { id: string; list: TracerAttachment[] }) {
  return (
    <Section
      title="Attachments"
      description="Files the device sent. A screenshot is shown when its bytes are an image; anything else is a download your browser will not open."
    >
      <Stack gap="md">
        {list.map((a) => (
          <AttachmentRow key={a.id} id={id} a={a} />
        ))}
      </Stack>
    </Section>
  );
}

function AttachmentRow({ id, a }: { id: string; a: TracerAttachment }) {
  const role = attachmentRole(a);
  const act = useAction();
  const [img, setImg] = useState<string | null>(null);
  const [tree, setTree] = useState<unknown>(undefined);
  const [note, setNote] = useState<string | null>(null);
  // Blob URLs live as long as the row.
  useEffect(
    () => () => {
      if (img) URL.revokeObjectURL(img);
    },
    [img],
  );
  const name = plain(a.filename ?? a.id, 120);
  const bytes = () => act.run(() => tracerRead(api.tracerAttachment(id, a.id)));

  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const showImage = async () => {
    const b = await bytes();
    if (!b || !alive.current) return;
    const { blob, image } = safeBlob(b);
    if (!image) {
      setNote("Not an image after all: download it instead.");
      return;
    }
    setImg(URL.createObjectURL(blob));
  };
  const showTree = async () => {
    if (a.size > VIEW_HIERARCHY_MAX_BYTES) {
      setNote(
        `Too large to show here (${fmtBytes(a.size)}); download it instead.`,
      );
      return;
    }
    const b = await bytes();
    if (!b) return;
    try {
      setTree(JSON.parse(new TextDecoder().decode(b)));
    } catch {
      setNote("Not valid JSON: download it instead.");
    }
  };
  // A screenshot is what the page is opened for: load it at once.
  useEffect(() => {
    if (role === "screenshot" && a.size <= SCREENSHOT_AUTOLOAD_MAX_BYTES)
      void showImage();
    // Once per row: the attachment never changes under it.
  }, []);
  const download = async () => {
    const b = await bytes();
    if (!b) return;
    // Always octet-stream: a download, never a page in the console origin.
    const url = URL.createObjectURL(
      new Blob([b.slice().buffer], { type: "application/octet-stream" }),
    );
    const link = document.createElement("a");
    link.href = url;
    // Never the device's name: `invoice.pdf.exe` would keep its extension.
    link.download = `${a.id}.bin`;
    link.rel = "noopener";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <Box>
      <Group gap="xs" mb={4} wrap="nowrap">
        <Text size="sm" fw={500}>
          {name}
        </Text>
        <Text size="xs" c="dimmed">
          {plain(a.contentType ?? "", 60)} · {fmtBytes(a.size)}
        </Text>
      </Group>
      <Group gap="xs">
        {role === "screenshot" && !img && !note && (
          <Button
            variant="default"
            size="xs"
            loading={act.busy}
            onClick={() => void showImage()}
          >
            Show {name}
          </Button>
        )}
        {role === "viewHierarchy" && tree === undefined && (
          <Button
            variant="default"
            size="xs"
            loading={act.busy}
            onClick={() => void showTree()}
          >
            Show view hierarchy {name}
          </Button>
        )}
        <Button
          variant="default"
          size="xs"
          disabled={act.busy}
          onClick={() => void download()}
        >
          Download {name}
        </Button>
      </Group>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {note && (
        <Text size="sm" c="dimmed" mt={4}>
          {note}
        </Text>
      )}
      {img && (
        <Image
          src={img}
          alt={`Screenshot ${name}`}
          maw={360}
          mt="xs"
          radius="sm"
          fit="contain"
        />
      )}
      {tree !== undefined && (
        <Box mt="xs">
          <JsonTree
            value={tree}
            label="view hierarchy"
            maxDepth={64}
            maxNodes={5000}
            openDepth={2}
          />
        </Box>
      )}
    </Box>
  );
}
