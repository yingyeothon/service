import { Anchor, Button, Table, Text, Textarea } from "@mantine/core";
import { useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { DataTable } from "../components/DataTable";
import { EnumFilter, FilterBar } from "../components/FilterBar";
import {
  LimitValueField,
  RequestDetailsDrawer,
  RequestFacts,
  useRefreshPendingLimitCount,
} from "../components/Limits";
import { PageHeader } from "../components/PageHeader";
import { ResourceDrawer, useDrawerForm } from "../components/ResourceDrawer";
import { RowMenu, type RowMenuItem } from "../components/RowMenu";
import { Badge, Notice } from "../components/ui";
import { useCursorList } from "../lib/cursor";
import { fmtRelative } from "../lib/format";
import {
  LIMIT_STATUS_TONE,
  fmtRequestValue,
  formLimitValue,
  limitLabel,
  limitValueProblem,
  splitBytes,
  type Amount,
  type ByteUnit,
} from "../lib/limits";
import { notify } from "../lib/notify";
import { useAction } from "../lib/query";
import { projectUrl, teamUrl } from "../lib/team";
import {
  LIMIT_REQUEST_STATUSES,
  type LimitRequest,
  type LimitRequestStatus,
  type LimitValue,
} from "../types";

/*
 * The platform admin's queue of limit requests (docs/decisions.md *Limit
 * requests* #3): approve (optionally adjusting the value, up to the ceiling)
 * or reject with a note. Cursor-paged like the audit log.
 */

type StatusFilter = LimitRequestStatus | "all";

/** One ellipsed line for a name that may run to 64 characters (`rules/ui.md` #2). */
const CLIP = {
  display: "inline-block",
  maxWidth: 160,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  verticalAlign: "bottom",
} as const;
const NOWRAP = { whiteSpace: "nowrap" } as const;

/** Where the scope of a request lives in the console. */
function scopeUrl(r: LimitRequest): string {
  switch (r.scope.kind) {
    case "bundle":
      return `/assets/${encodeURIComponent(r.scope.id)}`;
    case "channel":
      return `/channels/${encodeURIComponent(r.scope.id)}`;
    case "project":
      return projectUrl(r.teamId, r.scope.id, "assets");
    case "team":
      return teamUrl(r.teamId);
  }
}

/** `bundle dungeon-maps`: the kind dimmed, the name a link to the scope. */
export function ScopeCell({ r }: { r: LimitRequest }) {
  return (
    <Table.Td style={NOWRAP}>
      <Text span size="sm" c="dimmed">
        {r.scope.kind}{" "}
      </Text>
      <Anchor component={Link} to={scopeUrl(r)} size="sm" style={CLIP}>
        {r.scope.name ?? r.scope.id}
      </Anchor>
    </Table.Td>
  );
}

/**
 * The requester's login, clipped: a GitHub login runs to 39 characters. The
 * full one is in the row's drawer (Approve, Details).
 */
export function RequesterCell({ r }: { r: LimitRequest }) {
  return (
    <Table.Td style={NOWRAP}>
      <Text span size="sm" style={{ ...CLIP, maxWidth: 120 }}>
        {r.createdByLogin ?? r.createdBy}
      </Text>
    </Table.Td>
  );
}

/**
 * The status badge and how long ago it got there. Inline, not a flex row: a
 * Mantine badge is `overflow: hidden`, so as a flex item it shrank and
 * ellipsed its own label ("p…") instead of widening the column. The extra
 * right padding keeps "2m ago" off the row menu beside it.
 */
export function StatusCell({ r }: { r: LimitRequest }) {
  return (
    <Table.Td style={{ ...NOWRAP, paddingRight: 24 }}>
      <Badge tone={LIMIT_STATUS_TONE[r.status]}>{r.status}</Badge>{" "}
      <Text span size="sm" c="dimmed">
        {fmtRelative(r.decidedAt ?? r.createdAt)}
      </Text>
    </Table.Td>
  );
}

interface ApproveForm {
  amount: Amount;
  byteUnit: ByteUnit;
  note: string;
}

/** The drawer opens on the requested value, in the unit that reads best. */
function approveForm(r: LimitRequest | null): ApproveForm {
  const v: LimitValue = r?.requestedValue ?? "unlimited";
  const unit = r?.unit ?? "count";
  if (typeof v !== "number" || unit === "seconds")
    return { amount: "", byteUnit: "MiB", note: "" };
  if (unit === "bytes") {
    const { amount, unit: byteUnit } = splitBytes(v);
    return { amount, byteUnit, note: "" };
  }
  return { amount: v, byteUnit: "MiB", note: "" };
}

export function LimitRequestsPage() {
  const [status, setStatus] = useState<StatusFilter>("pending");
  const list = useCursorList(
    ["admin", "limit-requests", status],
    (cursor) =>
      api.adminLimitRequests({
        status: status === "all" ? undefined : status,
        cursor,
      }),
    (page) => page.requests,
    { keepPrevious: true },
  );
  const refreshBadge = useRefreshPendingLimitCount();
  const act = useAction();
  const [target, setTarget] = useState<LimitRequest | null>(null);
  const [viewing, setViewing] = useState<LimitRequest | null>(null);
  // `useDrawerForm` reads its initial values when it opens: the row picked
  // in the same click has to reach it before the state update does.
  const picked = useRef<LimitRequest | null>(null);
  const drawer = useDrawerForm<ApproveForm>(() => approveForm(picked.current));
  const f = drawer.form;

  const unit = target?.unit ?? "count";
  const value = formLimitValue(unit, f.amount, f.byteUnit);
  const problem = target
    ? limitValueProblem(unit, value, target.hard ?? undefined)
    : null;

  const after = async () => {
    await Promise.all([list.reload(), refreshBadge()]);
  };
  const openApprove = (r: LimitRequest) => {
    picked.current = r;
    setTarget(r);
    act.clear();
    drawer.open();
  };
  const approve = async (e: FormEvent) => {
    e.preventDefault();
    if (!target || value === null || problem !== null) return;
    const body: { value?: LimitValue; note?: string } = {};
    if (value !== target.requestedValue) body.value = value;
    const note = f.note.trim();
    if (note) body.note = note;
    const r = await act.run(() => api.approveLimitRequest(target.id, body));
    if (!r) return;
    drawer.close();
    notify.done(`${limitLabel(r.key)} request approved`);
    await after();
  };
  const reject = async (r: LimitRequest, note: string | undefined) => {
    if (!note) return;
    const ok = await act.run(() => api.rejectLimitRequest(r.id, note));
    if (!ok) return;
    notify.done(`${limitLabel(r.key)} request rejected`);
    await after();
  };

  const items = (r: LimitRequest): RowMenuItem[] =>
    r.status === "pending"
      ? [
          {
            label: "Approve",
            disabled: act.busy,
            onClick: () => openApprove(r),
          },
          {
            label: "Reject",
            danger: true,
            disabled: act.busy,
            onClick: (note) => reject(r, note),
            confirm: {
              title: `Reject the ${limitLabel(r.key)} request?`,
              message: `${r.createdByLogin ?? r.createdBy} asked for ${fmtRequestValue(r, r.requestedValue)}: “${r.reason}”. The team cannot ask for this limit again for 7 days.`,
              confirmLabel: "Reject request",
              danger: true,
              reason: {
                required: true,
                maxLength: 2000,
                placeholder: "The team reads this note.",
              },
            },
          },
        ]
      : [{ label: "Details", onClick: () => setViewing(r) }];

  const pending = list.first?.pending;
  const oldest = list.first?.oldestPendingAt ?? null;
  return (
    <>
      <PageHeader
        title="Limit requests"
        description="Teams asking for more than the default. An approval grants up to the ceiling; a rejection needs a note, and the team cannot ask for the same limit again for 7 days."
        meta={
          pending === undefined ? undefined : (
            <>
              {pending} pending
              {oldest !== null && <> · oldest {fmtRelative(oldest)}</>}
            </>
          )
        }
      />
      <FilterBar>
        <EnumFilter
          label="Status"
          value={status}
          options={[
            ...LIMIT_REQUEST_STATUSES.map((s) => ({ value: s, label: s })),
            { value: "all", label: "all" },
          ]}
          onChange={(v) => setStatus(v as StatusFilter)}
        />
      </FilterBar>
      {act.error && !drawer.opened && <Notice kind="error">{act.error}</Notice>}
      <DataTable
        columns={[
          { key: "team", label: "Team" },
          { key: "scope", label: "Scope" },
          { key: "limit", label: "Limit" },
          { key: "value", label: "Requested", align: "right" },
          { key: "by", label: "Requester" },
          { key: "status", label: "Status" },
        ]}
        rows={list.rows}
        loading={list.loading}
        fetching={list.fetching}
        error={list.error}
        rowKey={(r) => r.id}
        minWidth={720}
        empty={{
          title:
            status === "pending" ? "Nothing is waiting." : "No requests here.",
        }}
        render={(r) => (
          <>
            <Table.Td style={NOWRAP}>
              <Anchor
                component={Link}
                to={teamUrl(r.teamId)}
                size="sm"
                style={{ ...CLIP, maxWidth: 120 }}
              >
                {r.teamName ?? r.teamId}
              </Anchor>
            </Table.Td>
            <ScopeCell r={r} />
            <Table.Td style={NOWRAP}>{limitLabel(r.key)}</Table.Td>
            <Table.Td style={{ ...NOWRAP, textAlign: "right" }}>
              {fmtRequestValue(r, r.requestedValue)}
            </Table.Td>
            <RequesterCell r={r} />
            <StatusCell r={r} />
          </>
        )}
        actions={(r) => (
          <RowMenu
            name={`${limitLabel(r.key)} of ${r.scope.name ?? r.scope.id}`}
            items={items(r)}
          />
        )}
      />
      {list.next && (
        <Button
          variant="default"
          mt="md"
          disabled={list.busy || list.fetching}
          onClick={() => void list.loadMore()}
        >
          Load more
        </Button>
      )}
      <ResourceDrawer
        opened={drawer.opened}
        onClose={drawer.close}
        title="Approve request"
        submitLabel="Approve request"
        onSubmit={approve}
        busy={act.busy}
        disabled={value === null || problem !== null}
        error={drawer.opened ? act.error : null}
      >
        {target && (
          <>
            <RequestFacts r={target} />
            <LimitValueField
              label="Grant"
              unit={unit}
              amount={f.amount}
              byteUnit={f.byteUnit}
              onAmount={(amount) => drawer.patch({ amount })}
              onByteUnit={(byteUnit) => drawer.patch({ byteUnit })}
              description={
                unit === "seconds"
                  ? "The channel stops expiring, and a disabled one comes back."
                  : `Requested ${fmtRequestValue(target, target.requestedValue)}${
                      target.hard !== null
                        ? `; the ceiling is ${fmtRequestValue(target, target.hard)}`
                        : ""
                    }.`
              }
              error={f.amount === "" ? null : problem}
            />
            <Textarea
              label="Note"
              description="Optional. The team reads it."
              value={f.note}
              onChange={(e) => drawer.patch({ note: e.currentTarget.value })}
              maxLength={2000}
              autosize
              minRows={2}
            />
          </>
        )}
      </ResourceDrawer>
      <RequestDetailsDrawer
        request={viewing}
        onClose={() => setViewing(null)}
      />
    </>
  );
}
