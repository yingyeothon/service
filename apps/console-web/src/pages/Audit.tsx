import {
  Button,
  Code,
  Group,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "../api";
import { Notice, Spinner } from "../components/ui";
import { fmtTime } from "../lib/format";
import { useAction } from "../lib/query";
import type { AuditDetail, AuditFilter, AuditRow } from "../types";

/**
 * The audit log's first read side (`docs/decisions.md` *Show (console)*,
 * decision 12): a log nobody can read is not an operational tool. Cursor-paged
 * like `HistoryList`, but its own component — the two carry different rows and
 * refactoring the team history to share this would be churn.
 *
 * A listed row never carries `detail`: a deletion snapshot is far too large to
 * page. Opening a row fetches it.
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

  return (
    <Stack gap="sm">
      <Title order={2}>Audit log</Title>
      <Text size="sm" c="dimmed">
        Every recorded write on the platform. Moderation carries the reason the
        operator gave.
      </Text>
      <Group gap="xs" align="flex-end">
        <TextInput
          size="xs"
          label="Action starts with"
          placeholder="show."
          value={prefix}
          onChange={(e) => setPrefix(e.currentTarget.value)}
        />
        <TextInput
          size="xs"
          label="Actor (GitHub login)"
          value={actor}
          onChange={(e) => setActor(e.currentTarget.value)}
        />
        <TextInput
          size="xs"
          label="Target id"
          value={target}
          onChange={(e) => setTarget(e.currentTarget.value)}
        />
        <Button size="compact-sm" onClick={() => setApplied((n) => n + 1)}>
          Apply
        </Button>
      </Group>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nothing matches.
        </Text>
      ) : (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>When</Table.Th>
              <Table.Th>Action</Table.Th>
              <Table.Th>Actor</Table.Th>
              <Table.Th>Target</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r) => (
              <Table.Tr key={r.id}>
                <Table.Td>{fmtTime(r.at)}</Table.Td>
                <Table.Td>
                  <Code>{r.action}</Code>
                </Table.Td>
                <Table.Td>{r.actor ?? "system"}</Table.Td>
                <Table.Td>{r.target ?? "—"}</Table.Td>
                <Table.Td>
                  <Button
                    size="compact-xs"
                    variant="subtle"
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
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {next && (
        <Button
          size="compact-sm"
          variant="default"
          disabled={act.busy}
          onClick={() => void load(live, next)}
        >
          Load more
        </Button>
      )}
      {open && (
        <Stack gap={4}>
          <Group gap="xs">
            <Text size="sm" fw={600}>
              {open.action}
            </Text>
            <Text size="xs" c="dimmed">
              {open.actor ?? "system"} · {fmtTime(open.at)}
            </Text>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => setOpen(null)}
            >
              Close
            </Button>
          </Group>
          {open.detailTruncated && (
            <Notice kind="warn">
              Shortened: this row is larger than the detail view returns.
            </Notice>
          )}
          <Code block style={{ whiteSpace: "pre-wrap" }}>
            {open.detail ?? "(no detail)"}
          </Code>
        </Stack>
      )}
    </Stack>
  );
}
