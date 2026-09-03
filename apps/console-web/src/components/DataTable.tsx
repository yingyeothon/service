import {
  Anchor,
  Skeleton,
  Table,
  UnstyledButton,
  VisuallyHidden,
} from "@mantine/core";
import {
  IconArrowDown,
  IconArrowUp,
  IconArrowsSort,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { SortState } from "../lib/listQuery";
import type { SortOrder } from "../types";
import { EmptyState } from "./EmptyState";
import { Notice } from "./ui";

export interface Column {
  key: string;
  label: ReactNode;
  align?: "left" | "right";
  width?: number | string;
  /** The server's sort key for this column; absent, the header is plain text. */
  sortKey?: string;
  /** The order the first click asks for: `desc` for times and counts. */
  defaultOrder?: SortOrder;
}

/**
 * Every list in the console: a scroll container, hairline rows, tabular
 * figures, and the loading, error and empty states rendered where the rows
 * would be. `render` returns the cells after `NameCell`/`Table.Td` — one
 * fragment per row. A column with `sortKey` renders its header as a button
 * that cycles `defaultOrder` → the other order → the server's default; the
 * page owns the state (`sort`/`onSort`) because the order is a request
 * parameter, never a client-side reorder.
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
  sort,
  onSort,
  fetching,
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
  sort?: SortState | null;
  onSort?: (next: SortState | null) => void;
  /** Dims the rows while a re-sort or search is in flight. */
  fetching?: boolean;
}) {
  const cycle = (c: Column) => {
    if (!c.sortKey || !onSort) return;
    const first = c.defaultOrder ?? "asc";
    if (sort?.key !== c.sortKey)
      return onSort({ key: c.sortKey, order: first });
    if (sort.order === first)
      return onSort({
        key: c.sortKey,
        order: first === "asc" ? "desc" : "asc",
      });
    return onSort(null);
  };
  const header = (c: Column) => {
    const order =
      c.sortKey && sort && sort.key === c.sortKey ? sort.order : undefined;
    const active = order !== undefined;
    const Icon =
      order === "asc"
        ? IconArrowUp
        : order === "desc"
          ? IconArrowDown
          : IconArrowsSort;
    return (
      <Table.Th
        key={c.key}
        aria-sort={
          order === "asc"
            ? "ascending"
            : order === "desc"
              ? "descending"
              : undefined
        }
        style={{
          textAlign: c.align ?? "left",
          width: c.width,
          whiteSpace: "nowrap",
        }}
      >
        {c.sortKey && onSort ? (
          <UnstyledButton
            type="button"
            onClick={() => cycle(c)}
            style={{
              font: "inherit",
              color: "inherit",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {c.label}
            <Icon
              size={14}
              aria-hidden="true"
              style={{ opacity: active ? 1 : 0.45 }}
            />
          </UnstyledButton>
        ) : (
          c.label
        )}
      </Table.Th>
    );
  };
  if (error && !rows) return <Notice kind="error">{error}</Notice>;
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
  if (rows.length === 0)
    return (
      <>
        {error && <Notice kind="error">{error}</Notice>}
        {sort && onSort && (
          // A sorted list that matches nothing keeps its header, so the
          // order stays visible and can be cleared from where it was set.
          <Table.ScrollContainer minWidth={minWidth}>
            <Table>
              <Table.Thead>
                <Table.Tr>{columns.map(header)}</Table.Tr>
              </Table.Thead>
            </Table>
          </Table.ScrollContainer>
        )}
        <EmptyState {...empty} />
      </>
    );
  return (
    <>
      {error && <Notice kind="error">{error}</Notice>}
      <Table.ScrollContainer minWidth={minWidth}>
        <Table
          aria-busy={fetching ? "true" : undefined}
          style={fetching ? { opacity: 0.6 } : undefined}
        >
          <Table.Thead>
            <Table.Tr>
              {columns.map(header)}
              {actions && (
                <Table.Th style={{ width: 48 }}>
                  {/* Mantine 8 ships no `mantine-visually-hidden` class: the
                      word used to render, in every table, and sized the
                      column with it. */}
                  <VisuallyHidden>Actions</VisuallyHidden>
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
    </>
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
