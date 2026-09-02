import { Button, Code, Table, TextInput } from "@mantine/core";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { DataTable } from "../components/DataTable";
import { FilterBar } from "../components/FilterBar";
import { PageHeader } from "../components/PageHeader";
import { Section } from "../components/Section";
import { Notice } from "../components/ui";
import { fmtTime } from "../lib/format";
import { useAction } from "../lib/query";
import type { AuditDetail, AuditFilter, AuditRow } from "../types";

/**
 * The audit log's first read side (`docs/decisions.md` *Show (console)*,
 * decision 12): a log nobody can read is not an operational tool. Cursor-paged
 * like `HistoryList`, but its own component — the two carry different rows.
 *
 * A listed row never carries `detail`: a deletion snapshot is far too large to
 * page. Opening a row fetches it. This is the console's one free-text filter,
 * hence its one `Apply` button.
 */
export function AuditPage() {
  const act = useAction();
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [prefix, setPrefix] = useState("");
  const [actor, setActor] = useState("");
  const [target, setTarget] = useState("");
  const [open, setOpen] = useState<AuditDetail | null>(null);
  const [applied, setApplied] = useState(0);

  /**
   * The filter the current page was fetched with. "Load more" must reuse it:
   * reading the live inputs would append rows from a differently-filtered
   * query under a cursor from the old one.
   */
  const [live, setLive] = useState<AuditFilter>({});
  const load = async (filter: AuditFilter, cursor?: string) => {
    const page = await act.run(() => api.audit({ ...filter, cursor }));
    if (!page) return;
    setRows((prev) => [...(cursor ? (prev ?? []) : []), ...page.rows]);
    setNext(page.next);
  };
  useEffect(() => {
    const filter: AuditFilter = {
      actionPrefix: prefix.trim() || undefined,
      actor: actor.trim() || undefined,
      target: target.trim() || undefined,
    };
    setLive(filter);
    setRows(null);
    setNext(null);
    setOpen(null);
    void load(filter);
    // `load` closes over `act.run`, which is stable; refetch when Apply moves.
  }, [applied]);
  const apply = (e: FormEvent) => {
    e.preventDefault();
    setApplied((n) => n + 1);
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every recorded write on the platform. Moderation carries the reason the operator gave."
      />
      <form onSubmit={apply}>
        <FilterBar>
          <TextInput
            label="Action starts with"
            placeholder="show."
            value={prefix}
            onChange={(e) => setPrefix(e.currentTarget.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <TextInput
            label="Actor (GitHub login)"
            value={actor}
            onChange={(e) => setActor(e.currentTarget.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <TextInput
            label="Target id"
            value={target}
            onChange={(e) => setTarget(e.currentTarget.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" variant="default">
            Apply
          </Button>
        </FilterBar>
      </form>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <DataTable
        columns={[
          { key: "when", label: "When" },
          { key: "action", label: "Action" },
          { key: "actor", label: "Actor" },
          { key: "target", label: "Target" },
          { key: "detail", label: "" },
        ]}
        rows={rows ?? undefined}
        loading={rows === null}
        rowKey={(r) => r.id}
        minWidth={640}
        empty={{ title: "Nothing matches these filters." }}
        render={(r) => (
          <>
            <Table.Td>{fmtTime(r.at)}</Table.Td>
            <Table.Td>
              <Code>{r.action}</Code>
            </Table.Td>
            <Table.Td>{r.actor ?? "system"}</Table.Td>
            <Table.Td>{r.target ?? "—"}</Table.Td>
            <Table.Td>
              <Button
                size="compact-sm"
                variant="subtle"
                color="ink"
                onClick={() =>
                  void (async () => {
                    const d = await act.run(() => api.auditRow(r.id));
                    if (d) setOpen(d);
                  })()
                }
              >
                Detail
              </Button>
            </Table.Td>
          </>
        )}
      />
      {next && (
        <Button
          variant="default"
          mt="md"
          disabled={act.busy}
          onClick={() => void load(live, next)}
        >
          Load more
        </Button>
      )}
      {open && (
        <Section
          title={open.action}
          description={`${open.actor ?? "system"} · ${fmtTime(open.at)}`}
          actions={
            <Button variant="default" onClick={() => setOpen(null)}>
              Close
            </Button>
          }
        >
          {open.detailTruncated && (
            <Notice kind="warn">
              Shortened: this row is larger than the detail view returns.
            </Notice>
          )}
          <Code block style={{ whiteSpace: "pre-wrap" }}>
            {open.detail ?? "(no detail)"}
          </Code>
        </Section>
      )}
    </>
  );
}
