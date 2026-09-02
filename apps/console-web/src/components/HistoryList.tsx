import { Button, Code, Table, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "../api";
import { fmtTime } from "../lib/format";
import { useAction } from "../lib/query";
import type { TeamHistoryEntry } from "../types";
import { DataTable } from "./DataTable";
import { Notice } from "./ui";

const scalar = (x: unknown): string =>
  typeof x === "string"
    ? x
    : typeof x === "number" || typeof x === "boolean"
      ? String(x)
      : (JSON.stringify(x) ?? "");

/** Compact, secret-free rendering of `detail` (field names, roles, ids only). */
export function historyDetail(d: Record<string, unknown> | null): string {
  if (!d) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || v === null) continue;
    if (k === "resource" && typeof v === "object") {
      const r = v as { kind?: string; id?: string; name?: string };
      parts.push(`${r.kind ?? "resource"} ${r.name ?? r.id ?? ""}`.trim());
    } else if (Array.isArray(v))
      parts.push(`${k}: ${v.map(scalar).join(", ")}`);
    else parts.push(`${k}: ${scalar(v)}`);
  }
  return parts.join(" · ");
}

/**
 * Cursor-paged team history, newest first. Every member may read it; like the
 * audit log it never carries config values or secrets.
 */
export function HistoryList({ team }: { team: string }) {
  const act = useAction();
  const [rows, setRows] = useState<TeamHistoryEntry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);

  const load = async (cursor?: string) => {
    const page = await act.run(() => api.teamHistory(team, cursor));
    if (!page) return;
    setRows((prev) => [...(cursor ? (prev ?? []) : []), ...page.history]);
    setNext(page.next);
  };
  useEffect(() => {
    setRows(null);
    setNext(null);
    void load();
    // `load` closes over `act.run`, which is stable; refetch only per team.
  }, [team]);

  return (
    <>
      {act.error && rows !== null && <Notice kind="error">{act.error}</Notice>}
      <DataTable
        columns={[
          { key: "when", label: "When" },
          { key: "action", label: "Action" },
          { key: "actor", label: "Actor" },
          { key: "subject", label: "Subject" },
          { key: "detail", label: "Detail" },
        ]}
        rows={rows ?? undefined}
        loading={rows === null && !act.error}
        error={rows === null ? act.error : null}
        rowKey={(h) => h.id}
        minWidth={640}
        empty={{ title: "No history yet." }}
        render={(h) => (
          <>
            <Table.Td>{fmtTime(h.at)}</Table.Td>
            <Table.Td>
              <Code>{h.action}</Code>
            </Table.Td>
            <Table.Td>{h.actor ?? "—"}</Table.Td>
            <Table.Td>{h.subject ?? h.target ?? "—"}</Table.Td>
            <Table.Td>
              <Text size="xs" c="dimmed">
                {historyDetail(h.detail)}
              </Text>
            </Table.Td>
          </>
        )}
      />
      {next && (
        <Button
          variant="default"
          mt="md"
          disabled={act.busy}
          onClick={() => void load(next)}
        >
          Load more
        </Button>
      )}
    </>
  );
}
