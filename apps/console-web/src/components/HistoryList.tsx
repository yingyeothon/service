import { Button, Code, Table, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "../api";
import { fmtTime } from "../lib/format";
import { useAction } from "../lib/query";
import type { TeamHistoryEntry } from "../types";
import { Notice, Spinner } from "./ui";

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

  if (act.error && rows === null)
    return <Notice kind="error">{act.error}</Notice>;
  if (rows === null) return <Spinner />;
  return (
    <>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          No history yet.
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={640}>
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>When</Table.Th>
                <Table.Th>Action</Table.Th>
                <Table.Th>Actor</Table.Th>
                <Table.Th>Subject</Table.Th>
                <Table.Th>Detail</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((h) => (
                <Table.Tr key={h.id}>
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
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      {next && (
        <Button
          size="compact-sm"
          variant="default"
          mt="xs"
          disabled={act.busy}
          onClick={() => void load(next)}
        >
          Load more
        </Button>
      )}
    </>
  );
}
