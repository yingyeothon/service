import { Code, Table, Text } from "@mantine/core";
import { api } from "../api";
import { Clipped } from "../components/Clipped";
import { DataTable } from "../components/DataTable";
import { FoldCell } from "../components/FoldCell";
import { PageHeader } from "../components/PageHeader";
import { RowMenu, type RowMenuItem } from "../components/RowMenu";
import { Badge, Notice } from "../components/ui";
import { fmtRelative, fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { useAction, useApiQuery } from "../lib/query";
import type { PushPoolSlot } from "../types";

/*
 * The platform admin's view of the push pool (docs/decisions.md *Push
 * notifications (Android, FCM)*): the stage's Firebase projects, each named
 * by its slot label and never by a project id. A platform-sender channel
 * registers in the first open slot with room; closing a slot keeps new
 * registrations out of it and leaves its channels alone.
 */

const NOWRAP = { whiteSpace: "nowrap" } as const;
/*
 * A slot label runs to 32 characters and a GitHub login to 39; unclipped the
 * table needed 928 px against the 792 px the page has at a 1080 px window
 * (measured 2026-10-06). The common short value stays plain text.
 */
const SLOT_CHARS = 16;
const SLOT_WIDTH = 140;
const LOGIN_CHARS = 20;
const LOGIN_WIDTH = 150;

/** `closed_by` of a slot the platform closed when Firebase reported it full. */
const AUTO_PREFIX = "auto:";

/** Closed by the platform itself; the daily sweep reopens only such a slot. */
const autoClosed = (s: PushPoolSlot): boolean =>
  s.closed && (s.closedBy?.startsWith(AUTO_PREFIX) ?? false);

function closedBy(s: PushPoolSlot): string {
  if (s.closedBy === null) return "—";
  if (s.closedBy.startsWith(AUTO_PREFIX)) return "platform (app limit)";
  return s.closedByLogin ?? s.closedBy;
}

/**
 * One badge per row: a slot the stage no longer provisions takes nothing,
 * open or not, so that fact replaces the state (who closed it stays in its
 * own columns). Two badges did not fit the column (measured, 2026-10-06).
 */
function state(s: PushPoolSlot): { label: string; tone: string } {
  if (!s.provisioned) return { label: "not provisioned", tone: "danger" };
  if (s.closed) return { label: "closed", tone: "warn" };
  if (s.apps >= s.capacity) return { label: "full", tone: "danger" };
  return { label: "open", tone: "ok" };
}

export function PushPoolPage() {
  const pool = useApiQuery(["admin", "push-pool"], () => api.pushPool());
  const act = useAction();
  const slots = pool.data?.slots;
  // Room new registrations can still take: open, provisioned slots only.
  const usable = (slots ?? []).filter((s) => s.provisioned && !s.closed);
  const free = usable.reduce((n, s) => n + Math.max(0, s.capacity - s.apps), 0);

  const setClosed = async (s: PushPoolSlot, closed: boolean) => {
    const r = await act.run(() => api.setPushSlotClosed(s.slot, closed));
    if (!r) return;
    const word = closed ? "closed" : "open";
    // Closing a slot the platform closed itself changes who holds the
    // closure (`changed: true`), not whether it is closed.
    const tookOver = closed && r.changed && autoClosed(s);
    notify.done(
      tookOver
        ? `Slot ${s.slot} stays closed until you open it`
        : r.changed
          ? `Slot ${s.slot} ${closed ? "closed" : "opened"}`
          : `Slot ${s.slot} was already ${word}`,
    );
    await pool.reload();
  };

  return (
    <>
      <PageHeader
        title="Push pool"
        description="The Firebase projects of this stage that platform-sender push channels register in, by slot label. A new channel takes the first open slot with room. Closing a slot keeps new registrations out; the channels already in it keep working."
        meta={
          pool.data?.configured
            ? `${usable.length} open slot${usable.length === 1 ? "" : "s"} · ${free} registration${free === 1 ? "" : "s"} free`
            : undefined
        }
      />
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {pool.data && !pool.data.configured && (
        <Notice kind="warn">
          Push is not configured on this stage: no Firebase project is
          provisioned, so a platform-sender push channel cannot be created. Each
          project is one SecureString parameter under{" "}
          <Code>{"/yyt-service/{stage}/push/fcm/"}</Code>; the parameter name is
          the slot label.
        </Notice>
      )}
      {/* An unconfigured stage with no rows has nothing to list. */}
      {!(
        pool.data &&
        !pool.data.configured &&
        pool.data.slots.length === 0
      ) && (
        <DataTable
          columns={[
            { key: "slot", label: "Slot" },
            { key: "apps", label: "Apps", align: "right" },
            { key: "state", label: "State" },
            { key: "by", label: "Closed by" },
            { key: "at", label: "Closed" },
          ]}
          rows={slots}
          loading={pool.loading}
          error={pool.error}
          rowKey={(s) => s.slot}
          minWidth={560}
          empty={{ title: "No slots." }}
          render={(s) => {
            const st = state(s);
            const by = closedBy(s);
            return (
              <>
                <Table.Td style={NOWRAP}>
                  {s.slot.length > SLOT_CHARS ? (
                    <Clipped
                      text={s.slot}
                      width={SLOT_WIDTH}
                      what={`Full label of slot ${s.slot}`}
                    />
                  ) : (
                    <Code>{s.slot}</Code>
                  )}
                </Table.Td>
                <Table.Td
                  className="tabular"
                  style={{ ...NOWRAP, textAlign: "right" }}
                >
                  {s.apps} / {s.capacity}
                </Table.Td>
                <Table.Td style={NOWRAP}>
                  <Badge tone={st.tone}>{st.label}</Badge>
                </Table.Td>
                <Table.Td style={NOWRAP}>
                  {by.length > LOGIN_CHARS ? (
                    <FoldCell
                      label={by}
                      detail={by}
                      what={`Who closed slot ${s.slot}`}
                      width={LOGIN_WIDTH}
                    />
                  ) : (
                    by
                  )}
                </Table.Td>
                <Table.Td
                  style={NOWRAP}
                  title={s.closedAt === null ? undefined : fmtTime(s.closedAt)}
                >
                  {s.closedAt === null ? "—" : fmtRelative(s.closedAt)}
                </Table.Td>
              </>
            );
          }}
          actions={(s) => (
            <RowMenu
              name={`slot ${s.slot}`}
              items={(
                [
                  s.closed
                    ? {
                        label: "Open slot",
                        disabled: act.busy,
                        onClick: () => setClosed(s, false),
                        confirm: {
                          title: `Open slot ${s.slot}?`,
                          message: s.provisioned
                            ? "New platform-sender push channels may register in it again."
                            : "The slot is not provisioned on this stage: opening it changes nothing until its parameter exists.",
                          confirmLabel: "Open slot",
                        },
                      }
                    : undefined,
                  // The server lets an admin take an automatic closure over;
                  // without this item the only verb on such a slot was Open.
                  autoClosed(s)
                    ? {
                        label: "Keep closed",
                        disabled: act.busy,
                        onClick: () => setClosed(s, true),
                        confirm: {
                          title: `Keep slot ${s.slot} closed?`,
                          message:
                            "The platform closed this slot because its Firebase project is near the app limit, and the daily sweep reopens it once there is room. Keeping it closed makes the closure yours: it stays closed until an admin opens it.",
                          confirmLabel: "Keep closed",
                        },
                      }
                    : undefined,
                  s.closed
                    ? undefined
                    : {
                        label: "Close slot",
                        danger: true,
                        disabled: act.busy,
                        onClick: () => setClosed(s, true),
                        confirm: {
                          title: `Close slot ${s.slot}?`,
                          message:
                            "New platform-sender push channels stop registering in it. Its channels keep working, and it can be opened again.",
                          confirmLabel: "Close slot",
                          danger: true,
                        },
                      },
                ] as (RowMenuItem | undefined)[]
              ).filter((i): i is RowMenuItem => i !== undefined)}
            />
          )}
        />
      )}
      {slots?.some((s) => !s.provisioned) && (
        <Text size="sm" c="dimmed" mt="sm">
          A slot that is not provisioned still has channels or a closed mark in
          the database, but its parameter is gone: nothing can be registered in
          it or sent through it.
        </Text>
      )}
    </>
  );
}
