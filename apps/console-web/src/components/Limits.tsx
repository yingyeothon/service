import {
  Badge as MantineBadge,
  Button,
  Collapse,
  Group,
  NativeSelect,
  NumberInput,
  Stack,
  Table,
  Text,
  Textarea,
  UnstyledButton,
  VisuallyHidden,
} from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { fmtDate, fmtRelative, fmtTime, isNoExpiry } from "../lib/format";
import {
  BYTE_UNITS,
  defaultByteUnit,
  fmtLimit,
  fmtRequestValue,
  formLimitValue,
  limitLabel,
  limitScope,
  limitValueProblem,
  splitBytes,
  type Amount,
  type ByteUnit,
} from "../lib/limits";
import { notify } from "../lib/notify";
import { useAction, useApiQuery, type AsyncState } from "../lib/query";
import {
  canWriteTeam,
  isTeamOwner,
  type LimitRequest,
  type LimitRow,
  type LimitScopeKind,
  type LimitUnit,
  type LimitValue,
  type LimitsView,
  type TeamStanding,
} from "../types";
import { DataTable, NumCell } from "./DataTable";
import { ResourceDrawer, useDrawerForm } from "./ResourceDrawer";
import { RowMenu, type RowMenuItem } from "./RowMenu";
import { Section } from "./Section";
import { Badge, Notice } from "./ui";

/*
 * Limits of one scope (docs/decisions.md *Limit requests (soft/hard)*): the
 * effective value of every key, what is used, the hard ceiling, and the
 * pending requests. A seated member asks for more in a drawer; a platform
 * admin decides on `/admin/limit-requests`.
 */

/** `GET /limits` for one scope; the page and its section share the query. */
export function useLimits(
  kind: LimitScopeKind,
  id: string,
): AsyncState<LimitsView> {
  const scope = limitScope(kind, id);
  return useApiQuery(["limits", scope], () => api.limits(scope), {
    enabled: id !== "",
  });
}

const PENDING_COUNT_KEY = ["admin", "limit-requests", "pending-count"];

/**
 * Platform admin: how many requests wait, for the menu badge
 * (docs/decisions.md *Limit requests* #5). One row is asked for; the count
 * travels beside the page.
 */
export function usePendingLimitCount(enabled: boolean) {
  return useApiQuery(
    PENDING_COUNT_KEY,
    () =>
      api
        .adminLimitRequests({ status: "pending", limit: 1 })
        .then((p) => p.pending),
    { enabled },
  );
}

/** After an approval or a rejection: the badge lives in another component. */
export function useRefreshPendingLimitCount() {
  const client = useQueryClient();
  return useCallback(
    () => client.invalidateQueries({ queryKey: PENDING_COUNT_KEY }),
    [client],
  );
}

/** A key's effective value, while the view is loaded. */
export const effectiveLimit = (
  view: LimitsView | undefined,
  key: string,
): LimitValue | undefined => view?.limits.find((l) => l.key === key)?.effective;

const REASON_MAX_BYTES = 2048;
const reasonBytes = (s: string) => new TextEncoder().encode(s.trim()).length;

/**
 * A 429 from `POST /limit-requests` carries `details.retryAt`: the cooldown
 * after a rejection or cancellation. Read off the error object rather than
 * `instanceof ApiError` (the tests' mock carries no fields).
 */
function cooldownError(e: unknown): Error | null {
  const err = e as { status?: number; details?: { retryAt?: unknown } };
  const at = err.details?.retryAt;
  if (err.status !== 429 || typeof at !== "number") return null;
  return new Error(`You can ask again on ${fmtTime(at)}.`);
}

/**
 * The value of a request or a grant: a number with a unit selector for
 * bytes, a whole number for counts, and for a lifetime the one value there
 * is (#7), with no input at all.
 */
export function LimitValueField({
  unit,
  amount,
  byteUnit,
  onAmount,
  onByteUnit,
  description,
  error,
  label = "Value",
  fixed,
}: {
  unit: LimitUnit;
  amount: Amount;
  byteUnit: ByteUnit;
  onAmount: (v: Amount) => void;
  onByteUnit: (u: ByteUnit) => void;
  description?: ReactNode;
  error?: string | null;
  label?: string;
  /** A value the member cannot change (a stepped key's next step). */
  fixed?: string;
}) {
  if (unit === "seconds" || fixed !== undefined)
    return (
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          {label}
        </Text>
        <Text size="sm">{fixed ?? "No expiry"}</Text>
        {description && (
          <Text size="sm" c="dimmed">
            {description}
          </Text>
        )}
      </Stack>
    );
  return (
    <Group align="flex-start" gap="xs" wrap="nowrap">
      <NumberInput
        label={label}
        value={amount}
        onChange={onAmount}
        allowDecimal={unit === "bytes"}
        allowNegative={false}
        required
        description={description}
        error={error || undefined}
        inputWrapperOrder={["label", "input", "description", "error"]}
        style={{ flex: 1 }}
        data-autofocus
      />
      {unit === "bytes" && (
        <NativeSelect
          label="Unit"
          value={byteUnit}
          data={Object.keys(BYTE_UNITS)}
          onChange={(e) => onByteUnit(e.currentTarget.value as ByteUnit)}
          w={96}
        />
      )}
    </Group>
  );
}

/**
 * Label/value lines of a request: what was asked, why, and — once decided —
 * by whom, what was granted and the admin's note. The approve drawer and
 * every "Details" row action show it.
 */
export function RequestFacts({ r }: { r: LimitRequest }) {
  const line = (label: string, value: ReactNode) => (
    <Text size="sm">
      <Text span c="dimmed">
        {label}:{" "}
      </Text>
      {value}
    </Text>
  );
  return (
    <Stack gap={4}>
      {line("Team", r.teamName ?? r.teamId)}
      {line("Scope", `${r.scope.kind} ${r.scope.name ?? r.scope.id}`)}
      {line("Limit", limitLabel(r.key))}
      {line("Requested", fmtRequestValue(r, r.requestedValue))}
      {line(
        "Asked",
        `${fmtTime(r.createdAt)} by ${r.createdByLogin ?? r.createdBy}`,
      )}
      <Text size="sm" c="dimmed">
        Reason
      </Text>
      <Text
        size="sm"
        style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
      >
        {r.reason}
      </Text>
      {r.status !== "pending" && (
        <>
          {line("Status", r.status)}
          {line(
            r.status === "cancelled" ? "Cancelled" : "Decided",
            `${fmtTime(r.decidedAt)}${r.decidedByLogin ? ` by ${r.decidedByLogin}` : ""}`,
          )}
          {r.decidedValue !== null &&
            line("Granted", fmtRequestValue(r, r.decidedValue))}
          {r.decisionNote && line("Note", r.decisionNote)}
        </>
      )}
    </Stack>
  );
}

/** The read-only drawer behind a request row's "Details". */
export function RequestDetailsDrawer({
  request,
  onClose,
}: {
  request: LimitRequest | null;
  onClose: () => void;
}) {
  return (
    <ResourceDrawer
      opened={request !== null}
      onClose={onClose}
      title="Limit request"
      hideFooter
    >
      {request && <RequestFacts r={request} />}
    </ResourceDrawer>
  );
}

/**
 * The effective value of a raised key: a `raised` disclosure (a real button,
 * no hover) whose fold says since when, until when and why.
 */
function RaisedValue({ row }: { row: LimitRow }) {
  const [open, setOpen] = useState(false);
  const foldId = useId();
  const o = row.override!;
  const label = limitLabel(row.key);
  return (
    <>
      <Group gap={6} wrap="nowrap">
        <span>{fmtLimit(row.unit, row.effective)}</span>
        <UnstyledButton
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={foldId}
          style={{ paddingBlock: 4 }}
        >
          <MantineBadge
            component="span"
            color="ink"
            style={{ cursor: "pointer" }}
          >
            raised
          </MantineBadge>
          <VisuallyHidden> {label}: details</VisuallyHidden>
        </UnstyledButton>
        {o.expiresAt !== null && (
          <Text span size="sm" c="dimmed">
            until {fmtDate(o.expiresAt)}
          </Text>
        )}
      </Group>
      <Collapse in={open}>
        <Text
          size="sm"
          c="dimmed"
          id={foldId}
          role="group"
          aria-label={`${label} override`}
          mt={4}
          style={{ whiteSpace: "normal", maxWidth: 360 }}
        >
          Default {fmtLimit(row.unit, row.soft)} · raised {fmtTime(o.grantedAt)}
          {o.grantedByLogin ? ` by ${o.grantedByLogin}` : ""}
          {o.expiresAt !== null ? ` · until ${fmtTime(o.expiresAt)}` : ""}
          {o.note ? ` · ${o.note}` : ""}
        </Text>
      </Collapse>
    </>
  );
}

const NOWRAP = { whiteSpace: "nowrap" } as const;

/** "Cancel request", for the requester or a team owner; the server decides. */
export function cancelItem(
  r: LimitRequest,
  busy: boolean,
  onCancel: () => Promise<void>,
): RowMenuItem {
  return {
    label: "Cancel request",
    danger: true,
    disabled: busy,
    onClick: onCancel,
    confirm: {
      title: `Cancel the ${limitLabel(r.key)} request?`,
      message:
        "Cancelling counts as a rejection: this limit cannot be asked for again for 7 days.",
      confirmLabel: "Cancel request",
      cancelLabel: "Keep request",
      danger: true,
    },
  };
}

interface RequestForm {
  key: string;
  amount: Amount;
  byteUnit: ByteUnit;
  reason: string;
}

/** A platform admin's direct override (`PUT /admin/limit-overrides/…`). */
interface OverrideForm {
  key: string;
  amount: Amount;
  byteUnit: ByteUnit;
  /** A temporary raise, in whole days; empty = until revoked. */
  days: Amount;
  note: string;
}

const NOTE_MAX = 2000;

/** The set drawer opens on the key's effective value. */
function overrideForm(row: LimitRow | undefined): OverrideForm {
  const base = { key: row?.key ?? "", days: "", note: "" };
  const v = row?.effective;
  if (!row || typeof v !== "number" || row.unit === "seconds")
    return { ...base, amount: "", byteUnit: "MiB" };
  if (row.unit === "bytes") {
    const { amount, unit } = splitBytes(v);
    return { ...base, amount, byteUnit: unit };
  }
  return { ...base, amount: v, byteUnit: "MiB" };
}

const daysProblem = (d: Amount): string | null =>
  d === "" || (typeof d === "number" && Number.isSafeInteger(d) && d >= 1)
    ? null
    : "A whole number of days above 0.";

/**
 * The Limits section of a bundle, a project or a channel. `standing` is the
 * caller's standing in the scope's team (`useTeamStanding`): a seated member
 * may ask, a seatless admin only reads, and the requester or an owner may
 * cancel a pending request (the server decides; its refusal shows inline).
 */
export function LimitsSection({
  limits,
  standing,
  description,
  onChanged,
}: {
  limits: AsyncState<LimitsView>;
  standing: TeamStanding | undefined;
  description?: ReactNode;
  /** After an admin override: the page's own row may have moved too (a channel's expiry). */
  onChanged?: () => Promise<void>;
}) {
  const { me } = useAuth();
  const act = useAction();
  const ask = useAction();
  const setAct = useAction();
  const view = limits.data;
  const canWrite = canWriteTeam(standing);
  const owner = isTeamOwner(standing);
  // Overrides are the platform admin's, seated in the team or not (#3).
  const admin = me?.role === "admin";
  const [viewing, setViewing] = useState<LimitRequest | null>(null);

  // What may still be asked for: not already pending, not at its ceiling,
  // and no lifetime request for a channel that already has no expiry.
  const pendingKeys = new Set(view?.pending.map((r) => r.key) ?? []);
  const requestable = (view?.limits ?? []).filter((l) => {
    if (pendingKeys.has(l.key) || l.effective === "unlimited") return false;
    // A stepped key: the server says whether the next step may be asked for.
    if (l.step !== null) return l.next !== null;
    // The channel row is the truth for no expiry (the server answers 409).
    if (l.hard === "unlimited")
      return !(view?.expiresAt !== undefined && isNoExpiry(view.expiresAt));
    return l.effective < l.hard;
  });

  // A stepped key below its limit: say what unlocks the request.
  const stepped = view?.limits.find(
    (l) =>
      l.step !== null &&
      l.next === null &&
      !pendingKeys.has(l.key) &&
      typeof l.effective === "number" &&
      l.usage !== null,
  );
  const stepHint =
    stepped && typeof stepped.effective === "number" && stepped.usage !== null
      ? stepped.usage < stepped.effective
        ? `Ask for ${stepped.step} more once all ${stepped.effective} are in use (${stepped.usage} now).`
        : `At the ceiling of ${fmtLimit(stepped.unit, stepped.hard)}.`
      : null;

  const fresh = (row: LimitRow | undefined): RequestForm => ({
    key: row?.key ?? "",
    amount: row?.next ?? "",
    byteUnit: defaultByteUnit(row?.effective ?? 0),
    reason: "",
  });
  const drawer = useDrawerForm<RequestForm>(() => fresh(requestable[0]));
  const f = drawer.form;
  const row = view?.limits.find((l) => l.key === f.key);
  const value = row ? formLimitValue(row.unit, f.amount, f.byteUnit) : null;
  const valueProblem = row
    ? limitValueProblem(row.unit, value, row.hard, row.effective)
    : null;
  const reasonProblem =
    reasonBytes(f.reason) > REASON_MAX_BYTES
      ? `At most ${REASON_MAX_BYTES} bytes.`
      : null;
  const canSubmit =
    !!row &&
    value !== null &&
    valueProblem === null &&
    f.reason.trim() !== "" &&
    reasonProblem === null;

  const openDrawer = () => {
    ask.clear();
    drawer.open();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!view || !row || value === null || !canSubmit) return;
    const r = await ask.run(async () => {
      try {
        return await api.requestLimit({
          scope: limitScope(view.scope.kind, view.scope.id),
          key: row.key,
          value,
          reason: f.reason.trim(),
        });
      } catch (err) {
        throw cooldownError(err) ?? err;
      }
    });
    if (!r) return;
    drawer.close();
    notify.done("Request sent");
    await limits.reload();
  };
  const cancel = async (r: LimitRequest) => {
    const ok = await act.run(() => api.cancelLimitRequest(r.id));
    if (!ok) return;
    notify.done("Request cancelled");
    await limits.reload();
  };

  // `useDrawerForm` reads its initial values when it opens: the row picked
  // in the same click has to reach it before the state update does.
  const picked = useRef<LimitRow | undefined>(undefined);
  const setDrawer = useDrawerForm<OverrideForm>(() =>
    overrideForm(picked.current),
  );
  const o = setDrawer.form;
  const setRow = view?.limits.find((l) => l.key === o.key);
  const setValue = setRow
    ? formLimitValue(setRow.unit, o.amount, o.byteUnit)
    : null;
  const setProblem = setRow
    ? limitValueProblem(setRow.unit, setValue, setRow.hard)
    : null;
  // `channel.lifetime` refuses `expiresAt` (#7): no expiry is revoked, not timed.
  const temporary = setRow !== undefined && setRow.unit !== "seconds";
  const canSet =
    setRow !== undefined &&
    setValue !== null &&
    setProblem === null &&
    (!temporary || daysProblem(o.days) === null) &&
    o.note.trim() !== "";
  const afterOverride = async () => {
    await Promise.all([limits.reload(), onChanged?.()]);
  };
  const openSet = (l: LimitRow) => {
    picked.current = l;
    setAct.clear();
    setDrawer.open();
  };
  const submitSet = async (e: FormEvent) => {
    e.preventDefault();
    if (!view || !setRow || setValue === null || !canSet) return;
    const expiresAt =
      temporary && typeof o.days === "number"
        ? Math.floor(Date.now() / 1000) + o.days * 86400
        : undefined;
    const r = await setAct.run(() =>
      api.setLimitOverride(view.scope.kind, view.scope.id, setRow.key, {
        value: setValue,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        note: o.note.trim(),
      }),
    );
    if (!r) return;
    setDrawer.close();
    notify.done(
      `${limitLabel(setRow.key)} set to ${fmtLimit(setRow.unit, r.effective)}`,
    );
    await afterOverride();
  };
  const revoke = async (l: LimitRow, note: string | undefined) => {
    if (!view || !note) return;
    const ok = await act.run(async () => {
      await api.revokeLimitOverride(
        view.scope.kind,
        view.scope.id,
        l.key,
        note,
      );
      return true;
    });
    if (!ok) return;
    notify.done(`${limitLabel(l.key)} override revoked`);
    await afterOverride();
  };
  const adminItems = (l: LimitRow): RowMenuItem[] => [
    { label: "Set limit", disabled: act.busy, onClick: () => openSet(l) },
    ...(l.override
      ? [
          {
            label: "Revoke override",
            danger: true,
            disabled: act.busy,
            onClick: (note?: string) => revoke(l, note),
            confirm: {
              title: `Revoke the ${limitLabel(l.key)} override?`,
              message:
                l.unit === "seconds"
                  ? "The channel expires again, 28 days from now. Nothing stored is deleted."
                  : `New writes meet the default (${fmtLimit(l.unit, l.soft)}) again. Stored data stays, even above it.`,
              confirmLabel: "Revoke override",
              danger: true,
              reason: { required: true, maxLength: NOTE_MAX },
            },
          },
        ]
      : []),
  ];

  return (
    <Section
      title="Limits"
      description={
        description ??
        "Every scope starts at the default. A team member may ask a platform admin for more, up to the ceiling."
      }
      actions={
        canWrite &&
        (requestable.length > 0 ? (
          <Button variant="default" onClick={openDrawer}>
            Request increase
          </Button>
        ) : (
          stepHint && (
            <Text size="sm" c="dimmed">
              {stepHint}
            </Text>
          )
        ))
      }
    >
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <DataTable
        columns={[
          { key: "limit", label: "Limit" },
          { key: "usage", label: "Usage", align: "right" },
          { key: "effective", label: "Effective" },
          { key: "hard", label: "Ceiling", align: "right" },
        ]}
        rows={view?.limits}
        loading={limits.loading}
        error={limits.error}
        rowKey={(l) => l.key}
        minWidth={520}
        empty={{ title: "No limits apply here." }}
        render={(l) => {
          const over =
            l.usage !== null &&
            typeof l.effective === "number" &&
            l.usage > l.effective;
          return (
            <>
              <Table.Td style={NOWRAP}>{limitLabel(l.key)}</Table.Td>
              <Table.Td style={{ ...NOWRAP, textAlign: "right" }}>
                {l.usage === null ? "—" : fmtLimit(l.unit, l.usage)}
                {over && (
                  <>
                    {" "}
                    <Badge tone="danger">over</Badge>
                  </>
                )}
              </Table.Td>
              <Table.Td style={NOWRAP}>
                {l.override ? (
                  <RaisedValue row={l} />
                ) : (
                  fmtLimit(l.unit, l.effective)
                )}
              </Table.Td>
              <NumCell>{fmtLimit(l.unit, l.hard)}</NumCell>
            </>
          );
        }}
        actions={
          admin
            ? (l) => <RowMenu name={limitLabel(l.key)} items={adminItems(l)} />
            : undefined
        }
      />
      {view && view.pending.length > 0 && (
        <Stack gap="xs" mt="md">
          <Text size="sm" fw={500}>
            Pending requests
          </Text>
          <DataTable
            columns={[
              { key: "limit", label: "Limit" },
              { key: "value", label: "Requested", align: "right" },
              { key: "by", label: "Requester" },
              { key: "age", label: "Asked" },
            ]}
            rows={view.pending}
            rowKey={(r) => r.id}
            minWidth={480}
            empty={{ title: "Nothing pending." }}
            render={(r) => (
              <>
                <Table.Td style={NOWRAP}>{limitLabel(r.key)}</Table.Td>
                <Table.Td style={{ ...NOWRAP, textAlign: "right" }}>
                  {fmtRequestValue(r, r.requestedValue)}
                </Table.Td>
                <Table.Td style={NOWRAP}>
                  {r.createdByLogin ?? r.createdBy}
                </Table.Td>
                <Table.Td style={NOWRAP}>{fmtRelative(r.createdAt)}</Table.Td>
              </>
            )}
            actions={(r) => (
              <RowMenu
                name={`${limitLabel(r.key)} request`}
                items={[
                  { label: "Details", onClick: () => setViewing(r) },
                  ...(canWrite && (owner || r.createdBy === me?.id)
                    ? [cancelItem(r, act.busy, () => cancel(r))]
                    : []),
                ]}
              />
            )}
          />
        </Stack>
      )}
      <RequestDetailsDrawer
        request={viewing}
        onClose={() => setViewing(null)}
      />
      <ResourceDrawer
        opened={setDrawer.opened}
        onClose={setDrawer.close}
        title="Set limit"
        submitLabel="Set limit"
        onSubmit={submitSet}
        busy={setAct.busy}
        disabled={!canSet}
        error={setDrawer.opened ? setAct.error : null}
      >
        {setRow && (
          <>
            <Text size="sm">
              <Text span c="dimmed">
                Limit:{" "}
              </Text>
              {limitLabel(setRow.key)}
            </Text>
            <LimitValueField
              unit={setRow.unit}
              amount={o.amount}
              byteUnit={o.byteUnit}
              onAmount={(amount) => setDrawer.patch({ amount })}
              onByteUnit={(byteUnit) => setDrawer.patch({ byteUnit })}
              description={
                setRow.unit === "seconds"
                  ? "The channel stops expiring, and a disabled one comes back."
                  : `Default ${fmtLimit(setRow.unit, setRow.soft)}; the ceiling is ${fmtLimit(setRow.unit, setRow.hard)}.`
              }
              error={o.amount === "" ? null : setProblem}
            />
            {temporary && (
              <NumberInput
                label="Temporary (days)"
                description="Empty keeps it until revoked; a temporary one ends by itself."
                value={o.days}
                onChange={(days) => setDrawer.patch({ days })}
                allowDecimal={false}
                allowNegative={false}
                error={daysProblem(o.days) ?? undefined}
                inputWrapperOrder={["label", "input", "description", "error"]}
              />
            )}
            <Textarea
              label="Note"
              description="Kept with the override; the team reads it in the limit's details."
              value={o.note}
              onChange={(e) => setDrawer.patch({ note: e.currentTarget.value })}
              required
              maxLength={NOTE_MAX}
              autosize
              minRows={2}
            />
          </>
        )}
      </ResourceDrawer>
      <ResourceDrawer
        opened={drawer.opened}
        onClose={drawer.close}
        title="Request increase"
        submitLabel="Send request"
        onSubmit={submit}
        busy={ask.busy}
        disabled={!canSubmit}
        error={drawer.opened ? ask.error : null}
      >
        <NativeSelect
          label="Limit"
          value={f.key}
          data={requestable.map((l) => ({
            value: l.key,
            label: limitLabel(l.key),
          }))}
          onChange={(e) => {
            const next = view?.limits.find(
              (l) => l.key === e.currentTarget.value,
            );
            drawer.setForm((cur) => ({ ...fresh(next), reason: cur.reason }));
          }}
        />
        {row && (
          <LimitValueField
            unit={row.unit}
            amount={f.amount}
            byteUnit={f.byteUnit}
            onAmount={(amount) => drawer.patch({ amount })}
            onByteUnit={(byteUnit) => drawer.patch({ byteUnit })}
            fixed={row.next !== null ? fmtLimit(row.unit, row.next) : undefined}
            description={
              row.unit === "seconds"
                ? "The channel stops expiring once a platform admin approves."
                : row.next !== null
                  ? `${row.step} more than the current ${fmtLimit(row.unit, row.effective)}; this limit is raised in steps of ${row.step}, up to ${fmtLimit(row.unit, row.hard)}.`
                  : `Now ${fmtLimit(row.unit, row.effective)}; the ceiling is ${fmtLimit(row.unit, row.hard)}.`
            }
            error={f.amount === "" ? null : valueProblem}
          />
        )}
        <Textarea
          label="Reason"
          description="What it is for. A platform admin reads it before deciding."
          value={f.reason}
          onChange={(e) => drawer.patch({ reason: e.currentTarget.value })}
          required
          autosize
          minRows={3}
          error={reasonProblem ?? undefined}
        />
      </ResourceDrawer>
    </Section>
  );
}
