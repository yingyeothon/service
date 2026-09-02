import { Anchor, Skeleton, Table } from "@mantine/core";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { EmptyState } from "./EmptyState";
import { Notice } from "./ui";

export interface Column {
  key: string;
  label: ReactNode;
  align?: "left" | "right";
  width?: number | string;
}

/**
 * Every list in the console: a scroll container, hairline rows, tabular
 * figures, and the loading, error and empty states rendered where the rows
 * would be. `render` returns the cells after `NameCell`/`Table.Td` — one
 * fragment per row.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  render,
  loading,
  error,
  empty,
  minWidth = 560,
  actions,
}: {
  columns: Column[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  render: (row: T) => ReactNode;
  loading?: boolean;
  error?: string | null;
  empty: { title: string; hint?: ReactNode; action?: ReactNode };
  minWidth?: number;
  /** Adds a trailing, unlabeled column holding the row's menu. */
  actions?: (row: T) => ReactNode;
}) {
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!rows) {
    if (!loading) return null;
    return (
      <Table.ScrollContainer minWidth={minWidth}>
        <Table aria-busy="true" aria-label="Loading…">
          <Table.Tbody>
            {[0, 1, 2].map((i) => (
              <Table.Tr key={i}>
                <Table.Td colSpan={columns.length + (actions ? 1 : 0)}>
                  <Skeleton height={14} width={`${85 - i * 20}%`} />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    );
  }
  if (rows.length === 0) return <EmptyState {...empty} />;
  return (
    <Table.ScrollContainer minWidth={minWidth}>
      <Table>
        <Table.Thead>
          <Table.Tr>
            {columns.map((c) => (
              <Table.Th
                key={c.key}
                style={{
                  textAlign: c.align ?? "left",
                  width: c.width,
                  whiteSpace: "nowrap",
                }}
              >
                {c.label}
              </Table.Th>
            ))}
            {actions && (
              <Table.Th style={{ width: 48 }}>
                <span className="mantine-visually-hidden">Actions</span>
              </Table.Th>
            )}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <Table.Tr key={rowKey(row)}>
              {render(row)}
              {actions && (
                <Table.Td style={{ textAlign: "right" }}>
                  {actions(row)}
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/**
 * The name column: the in-app link every list opens its rows with. `after`
 * sits beside the link, outside its accessible name (a badge, a marker).
 */
export function NameCell({
  to,
  children,
  after,
}: {
  to: string;
  children: ReactNode;
  after?: ReactNode;
}) {
  return (
    <Table.Td>
      <Anchor component={Link} to={to} size="sm" fw={500}>
        {children}
      </Anchor>
      {after}
    </Table.Td>
  );
}

/** A right-aligned numeric cell. */
export function NumCell({ children }: { children: ReactNode }) {
  return <Table.Td style={{ textAlign: "right" }}>{children}</Table.Td>;
}
