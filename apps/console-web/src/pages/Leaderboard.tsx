import {
  Button,
  Code,
  Group,
  NativeSelect,
  NumberInput,
  Table,
  Text,
} from "@mantine/core";
import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { Crumbs } from "../components/Crumbs";
import { DataTable, NumCell } from "../components/DataTable";
import { FilterBar } from "../components/FilterBar";
import { PageSkeleton } from "../components/Loading";
import { NameDescriptionFields } from "../components/NameDescriptionFields";
import { PageHeader, type HeaderAction } from "../components/PageHeader";
import { ReadOnlyBanner } from "../components/ReadOnlyBanner";
import { ResourceDrawer, useDrawerForm } from "../components/ResourceDrawer";
import { RowMenu } from "../components/RowMenu";
import { Section } from "../components/Section";
import { Badge, CopyBlock, CopyField, Notice } from "../components/ui";
import { useConfirm } from "../lib/confirm";
import { fmtRelative, fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { useAction, useApiQuery } from "../lib/query";
import { projectUrl, useTeamStanding } from "../lib/team";
import { capOk, type CapValue } from "./KvCollection";
import type { Leaderboard, LbPeriod, LbScore } from "../types";

/*
 * A leaderboard is a project resource (`docs/decisions.md` *Serverless
 * clients* #1-#4): the console shows its shape and one bucket's ranked scores,
 * and may delete a score or a whole bucket. **It never writes one** — every
 * score comes through the LB API on the state stack, which is what makes each
 * row carry the credential that wrote it.
 */

export const lbUrl = (id: string) => `/leaderboards/${encodeURIComponent(id)}`;

/** Hard caps of `checkLbCaps`; the defaults are the form's initial values. */
export const LB_MAX_ENTRIES_HARD = 10_000;
export const LB_MAX_ENTRIES_DEFAULT = 2_000;
export const LB_RETAIN_MAX = 12;
export const LB_RETAIN_DEFAULT = 4;
/** How deep the console's own score table may page (the board's cap). */
export const LB_OFFSET_MAX = LB_MAX_ENTRIES_HARD;
export const LB_PAGE = 50;

export const LB_SUBMIT_LABEL: Record<Leaderboard["submit"], string> = {
  server: "server — the doc apiKey and nothing else",
  owner: "owner — a player writes its own row (the apiKey still may too)",
};
export const LB_RULE_LABEL: Record<Leaderboard["rule"], string> = {
  best: "best — keep the better score",
  latest: "latest — keep the newest score",
  sum: "sum — add to the stored score",
};
export const LB_ORDER_LABEL: Record<Leaderboard["order"], string> = {
  desc: "desc — highest ranks first",
  asc: "asc — lowest ranks first (times)",
};
export const LB_IMMUTABLE_NOTE =
  "Submit, rule, order and periods cannot be changed later: a board that changed how a new score meets the stored one would be ranking rows written under two different rules. Delete and recreate it instead.";

export function LbBadges({
  board,
}: {
  board: Pick<Leaderboard, "submit" | "rule" | "order">;
}) {
  return (
    <>
      <Badge tone="neutral">submit: {board.submit}</Badge>
      <Badge tone="neutral">{board.rule}</Badge>
      <Badge tone="neutral">{board.order}</Badge>
    </>
  );
}

/**
 * The bucket options of one board. A **period name** for the live bucket, plus
 * the past keys the retention window still holds — computed here in the same
 * `Asia/Seoul` arithmetic the server uses, because the alternative is asking
 * the server for a list of buckets it does not index.
 *
 * A key this list offers may hold nothing; the table then simply shows an
 * empty bucket, which is the honest answer and not an error.
 */
export function bucketOptions(
  board: Pick<Leaderboard, "periods" | "retainPeriods">,
  now = Date.now(),
): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const period of board.periods) {
    out.push({ value: period, label: `${period} (current)` });
    if (period === "alltime") continue;
    const span = period === "daily" ? 86_400_000 : 7 * 86_400_000;
    for (let i = 1; i <= board.retainPeriods; i++) {
      const key = periodKeyAt(period, now - i * span);
      out.push({ value: key, label: key });
    }
  }
  return out;
}

/** `lbPeriodKey` in the browser: KST is UTC+9 with no DST, so it is arithmetic. */
export function periodKeyAt(period: LbPeriod, ms: number): string {
  if (period === "alltime") return "";
  const kst = new Date(ms + 9 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (period === "daily")
    return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}`;
  // ISO week: Monday starts it, and the week belongs to the year holding its
  // Thursday — which is why `2027-01-01` is `2026-W53`.
  const day = Date.UTC(
    kst.getUTCFullYear(),
    kst.getUTCMonth(),
    kst.getUTCDate(),
  );
  const monday = (t: number) => (new Date(t).getUTCDay() + 6) % 7;
  const thursday = day + (3 - monday(day)) * 86_400_000;
  const year = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const first = jan4 + (3 - monday(jan4)) * 86_400_000;
  const week = 1 + Math.round((thursday - first) / (7 * 86_400_000));
  return `${year}-W${pad(week)}`;
}

export function LeaderboardPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const q = useApiQuery(["lb", id], () => api.leaderboard(id));
  const board = q.data;
  const standing = useTeamStanding(board?.teamId);
  const act = useAction();
  const confirm = useConfirm();
  const edit = useDrawerForm<{
    name: string;
    description: string;
    maxEntries: CapValue;
    retainPeriods: CapValue;
  }>(() => ({
    name: board?.name ?? "",
    description: board?.description ?? "",
    maxEntries: board?.maxEntries ?? LB_MAX_ENTRIES_DEFAULT,
    retainPeriods: board?.retainPeriods ?? LB_RETAIN_DEFAULT,
  }));

  /** `""` = the board's first period at its live key, which the server picks. */
  const [period, setPeriod] = useState("");
  const [offset, setOffset] = useState(0);
  const scoreAct = useAction();
  const page = useApiQuery(
    ["lb", id, "scores", period, offset],
    () =>
      api.lbScores(id, {
        ...(period === "" ? {} : { period }),
        limit: LB_PAGE,
        ...(offset === 0 ? {} : { offset }),
      }),
    { enabled: !!board, keepPrevious: true },
  );

  const crumbs = <Crumbs crumbs={board ?? {}} current={board?.name} />;
  if (q.error)
    return (
      <>
        {crumbs}
        <PageHeader />
        <Notice kind="error">{q.error}</Notice>
      </>
    );
  if (!board)
    return (
      <>
        {crumbs}
        <PageHeader />
        <PageSkeleton />
      </>
    );

  const canWrite = standing.canWrite;
  const rows = page.data?.scores;
  const total = page.data?.total ?? 0;
  // A seatless platform admin sees the ranking but never `meta`: it is the
  // team's own payload, the counterpart of a kv value (`team-access.ts`). The
  // server withholds it, and the column waits for the standing rather than
  // paint blanks meanwhile.
  const showMeta = !standing.loading && standing.standing !== "admin";

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body: {
      name?: string;
      description?: string | null;
      maxEntries?: number;
      retainPeriods?: number;
    } = {};
    const name = edit.form.name.trim();
    if (name !== board.name) body.name = name;
    const desc = edit.form.description.trim();
    if (desc !== (board.description ?? "")) body.description = desc || null;
    const { maxEntries, retainPeriods } = edit.form;
    if (!capOk(maxEntries, LB_MAX_ENTRIES_HARD) || !retainOk(retainPeriods))
      return;
    if (maxEntries !== board.maxEntries) body.maxEntries = maxEntries;
    if (retainPeriods !== board.retainPeriods)
      body.retainPeriods = retainPeriods;
    if (Object.keys(body).length === 0) {
      edit.close();
      return;
    }
    const r = await act.run(() => api.updateLeaderboard(id, body));
    if (!r) return;
    // PATCH answers the row without the bucket count; keep the one we have.
    q.set({
      ...r,
      scores: board.scores,
      period: board.period,
      periodKey: board.periodKey,
    });
    edit.close();
    notify.saved("leaderboard");
  };
  const remove = async () => {
    const ok = await act.run(async () => {
      await api.deleteLeaderboard(id);
      return true;
    });
    if (!ok) return;
    notify.deleted("leaderboard");
    void navigate(
      board.teamId && board.projectId
        ? projectUrl(board.teamId, board.projectId, "leaderboards")
        : "/teams",
    );
  };
  const removeScore = async (row: LbScore) => {
    const r = await scoreAct.run(() => api.deleteLbScore(id, row.owner));
    if (!r) return;
    notify.done(
      `${r.deleted} row${r.deleted === 1 ? "" : "s"} deleted across every period`,
    );
    await Promise.all([page.reload(), q.reload()]);
  };
  const clearBucket = async () => {
    const target = period === "" ? board.period : period;
    const r = await confirm({
      title: `Clear ${target}?`,
      message: `Every score in the ${target} bucket of this board is deleted. Other periods keep theirs.`,
      confirmLabel: "Clear period",
      danger: true,
    });
    if (!r.ok) return;
    const res = await scoreAct.run(() => api.deleteLbPeriod(id, target));
    if (!res) return;
    notify.done(
      res.truncated
        ? `${res.deleted} scores deleted; more remain, clear again`
        : `${res.deleted} scores deleted`,
    );
    setOffset(0);
    await Promise.all([page.reload(), q.reload()]);
  };

  const actions: HeaderAction[] = canWrite
    ? [
        {
          label: "Edit",
          onClick: () => {
            act.clear();
            edit.open();
          },
        },
      ]
    : [];
  const apiLines: (readonly [string, string])[] = [
    ["base", board.api.baseUrl],
    ["meta", board.api.metaPath],
    ["name", board.api.namePath],
    ["top", board.api.topPath],
    ["score", board.api.scorePath],
  ];
  const buckets = bucketOptions(board);

  return (
    <>
      {crumbs}
      <PageHeader
        title={board.name}
        badges={<LbBadges board={board} />}
        description={board.description ?? undefined}
        meta={
          <>
            {board.periods.join(", ")} · at most {board.maxEntries} per period ·
            keeps {board.retainPeriods} past period
            {board.retainPeriods === 1 ? "" : "s"} · Created by{" "}
            {board.createdBy ?? "—"} · {fmtTime(board.createdAt)} · id{" "}
            <Code>{board.id}</Code>
          </>
        }
        actions={actions}
      />
      {!canWrite && !standing.loading && <ReadOnlyBanner />}
      <Notice>
        The console never writes a score: every row arrives through the LB API,
        so each one names the credential that wrote it. Here you can read a
        bucket and delete.
      </Notice>
      {act.error && !edit.opened && <Notice kind="error">{act.error}</Notice>}
      <Section
        title="API"
        description="A game server sends the project's document API key (an auth channel's, issued on the channel page); a player sends the channel JWT it already holds and may write `me`. Every answer carries the bucket the platform picked, so a client never derives one from its own clock."
      >
        {!board.api.configured && (
          <Notice kind="warn">
            This stage has no state stack deployed, so the LB API does not
            answer here yet; the paths are the ones it will serve.
          </Notice>
        )}
        <CopyBlock label="LB API" lines={apiLines} />
      </Section>
      <Section
        title="Scores"
        description="One period bucket at a time, already ranked — equal scores share a rank. Past buckets stay for the retention window."
        actions={
          canWrite && (
            <Button
              variant="default"
              disabled={scoreAct.busy || total === 0}
              onClick={() => void clearBucket()}
            >
              Clear period
            </Button>
          )
        }
      >
        <FilterBar>
          <NativeSelect
            label="Period"
            value={period}
            data={[
              { value: "", label: `${board.period} (current)` },
              ...buckets.filter((b) => b.value !== board.period),
            ]}
            onChange={(e) => {
              setPeriod(e.currentTarget.value);
              setOffset(0);
            }}
          />
        </FilterBar>
        {scoreAct.error && <Notice kind="error">{scoreAct.error}</Notice>}
        <DataTable
          columns={[
            { key: "rank", label: "Rank", align: "right" as const },
            { key: "owner", label: "Owner" },
            { key: "score", label: "Score", align: "right" as const },
            ...(showMeta ? [{ key: "meta", label: "Meta" }] : []),
            { key: "channel", label: "Channel" },
            { key: "updated", label: "Updated" },
          ]}
          rows={rows}
          loading={page.loading}
          fetching={page.fetching}
          error={page.error}
          rowKey={(r) => r.owner}
          minWidth={showMeta ? 840 : 700}
          empty={{
            title: "No scores in this period.",
            hint: "Scores arrive through the LB API.",
          }}
          render={(r) => (
            <>
              <NumCell>{r.rank}</NumCell>
              <Table.Td>
                <Code>{r.owner}</Code>
              </Table.Td>
              <NumCell>{r.score}</NumCell>
              {/* A text node, never parsed: the stored bytes are whatever the
                  game sent (a control character is refused at write time). */}
              {showMeta && <Table.Td>{r.meta ?? "—"}</Table.Td>}
              <Table.Td>{r.channelId ?? "—"}</Table.Td>
              <Table.Td title={fmtTime(r.updatedAt)}>
                {fmtRelative(r.updatedAt)}
              </Table.Td>
            </>
          )}
          actions={
            canWrite
              ? (r) => (
                  <RowMenu
                    name={r.owner}
                    items={[
                      {
                        label: "Delete score",
                        danger: true,
                        disabled: scoreAct.busy,
                        onClick: () => removeScore(r),
                        confirm: {
                          title: `Delete ${r.owner}?`,
                          message:
                            "The owner's row goes from every period of this board, not only this one.",
                          confirmLabel: "Delete score",
                          danger: true,
                        },
                      },
                    ]}
                  />
                )
              : undefined
          }
        />
        <Group mt="sm" justify="space-between">
          <Text size="xs" c="dimmed">
            {total === 0
              ? "no scores"
              : `${offset + 1}–${Math.min(offset + LB_PAGE, total)} of ${total}`}
          </Text>
          <Group gap="xs">
            <Button
              variant="default"
              size="compact-sm"
              disabled={offset === 0 || page.fetching}
              onClick={() => setOffset(Math.max(0, offset - LB_PAGE))}
            >
              Previous
            </Button>
            <Button
              variant="default"
              size="compact-sm"
              disabled={
                offset + LB_PAGE >= total ||
                offset + LB_PAGE > LB_OFFSET_MAX ||
                page.fetching
              }
              onClick={() => setOffset(offset + LB_PAGE)}
            >
              Next
            </Button>
          </Group>
        </Group>
      </Section>
      <ResourceDrawer
        opened={edit.opened}
        onClose={edit.close}
        title="Edit leaderboard"
        submitLabel="Save"
        onSubmit={save}
        busy={act.busy}
        disabled={
          !edit.form.name.trim() ||
          !capOk(edit.form.maxEntries, LB_MAX_ENTRIES_HARD) ||
          !retainOk(edit.form.retainPeriods)
        }
        error={edit.opened ? act.error : null}
        danger={{
          label: "Delete leaderboard",
          description:
            "Every score goes with it; large boards drain in the background.",
          onConfirm: remove,
          disabled: act.busy,
        }}
      >
        <div>
          <CopyField label="Leaderboard id" value={board.id} />
          <Group gap="xs" my={4}>
            <LbBadges board={board} />
            <Badge tone="neutral">{board.periods.join(", ")}</Badge>
          </Group>
          <Text size="xs" c="dimmed">
            {LB_IMMUTABLE_NOTE}
          </Text>
        </div>
        <NameDescriptionFields
          name={edit.form.name}
          description={edit.form.description}
          onName={(name) => edit.patch({ name })}
          onDescription={(description) => edit.patch({ description })}
        />
        <LbCapFields
          maxEntries={edit.form.maxEntries}
          retainPeriods={edit.form.retainPeriods}
          onChange={(p) => edit.patch(p)}
        />
      </ResourceDrawer>
    </>
  );
}

/** `retainPeriods` may be 0 — keep only the live bucket — so `capOk` is too strict. */
export const retainOk = (v: CapValue): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= LB_RETAIN_MAX;

/** The two caps, shared by the create drawer (Project tab) and the edit drawer. */
export function LbCapFields({
  maxEntries,
  retainPeriods,
  onChange,
}: {
  maxEntries: CapValue;
  retainPeriods: CapValue;
  onChange: (p: { maxEntries?: CapValue; retainPeriods?: CapValue }) => void;
}) {
  return (
    <>
      <NumberInput
        label="Max entries per period"
        description={`1–${LB_MAX_ENTRIES_HARD}, counted on create. One board holds at most this times (1 + 2 × (past periods + 1)) — the current bucket of each period counts too.`}
        value={maxEntries}
        onChange={(v) => onChange({ maxEntries: v })}
        min={1}
        max={LB_MAX_ENTRIES_HARD}
        clampBehavior="none"
        allowDecimal={false}
        allowNegative={false}
        required
      />
      <NumberInput
        label="Past periods kept"
        description={`0–${LB_RETAIN_MAX}; the daily sweep drops older buckets. 0 keeps only the live one. The alltime bucket is never dropped.`}
        value={retainPeriods}
        onChange={(v) => onChange({ retainPeriods: v })}
        min={0}
        max={LB_RETAIN_MAX}
        clampBehavior="none"
        allowDecimal={false}
        allowNegative={false}
        required
      />
    </>
  );
}
