import { Anchor, Box, Code, Text } from "@mantine/core";
import { useState, type ReactNode } from "react";
import { plain, safeHref } from "../lib/tracer";

/*
 * Device-sent JSON (tracer contexts, breadcrumb data, a view hierarchy) as a
 * folding tree of plain text. Native `<details>`: keyboard and screen reader
 * support for free. A closed node renders no children at all — a timeline of
 * a thousand rows, each with a closed 16 KiB blob, stays a thousand rows —
 * and what is open is bounded by depth and by node count, so a hostile or
 * merely huge document cannot hang the page; what is left out says so.
 */

export interface JsonTreeLimits {
  /** Deeper levels are summarised, not rendered. */
  maxDepth?: number;
  /** Nodes rendered in total; the rest is summarised. */
  maxNodes?: number;
  /** Levels open on first render. */
  openDepth?: number;
}

interface Walk {
  maxDepth: number;
  openDepth: number;
  budget: { left: number };
  /** Paths the reader toggled, with the state they chose. */
  toggled: Map<string, boolean>;
  toggle: (path: string, open: boolean) => void;
}

export function JsonTree({
  value,
  label = "root",
  maxDepth = 24,
  maxNodes = 2000,
  openDepth = 1,
}: { value: unknown; label?: string } & JsonTreeLimits) {
  const [toggled, setToggled] = useState(() => new Map<string, boolean>());
  const walk: Walk = {
    maxDepth,
    openDepth,
    budget: { left: maxNodes },
    toggled,
    toggle: (path, open) => {
      if ((toggled.get(path) ?? null) === open) return;
      setToggled((m) => new Map(m).set(path, open));
    },
  };
  return (
    <Box ff="monospace" fz="xs" className="yyt-json-tree">
      {node(label, label, value, 0, walk)}
    </Box>
  );
}

function scalar(v: unknown): ReactNode {
  if (typeof v === "string") {
    const href = safeHref(v);
    // The link reads as its parsed form (punycode host), never as the
    // device's spelling of it.
    return href ? (
      <Anchor href={href} target="_blank" rel="noopener noreferrer" fz="xs">
        {plain(href, 2000)}
      </Anchor>
    ) : (
      <Text
        span
        fz="xs"
        style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
      >
        {JSON.stringify(plain(v, 2000))}
      </Text>
    );
  }
  return (
    <Code fz="xs">{v === undefined ? "undefined" : JSON.stringify(v)}</Code>
  );
}

function node(
  key: string,
  path: string,
  v: unknown,
  depth: number,
  w: Walk,
): ReactNode {
  w.budget.left--;
  const pad = { paddingLeft: depth ? 12 : 0 };
  const name = (
    <Text span fz="xs" fw={600}>
      {plain(key, 200)}
    </Text>
  );
  if (v === null || typeof v !== "object")
    return (
      <div key={key} style={pad}>
        {name}: {scalar(v)}
      </div>
    );
  const entries: [string, unknown][] = Array.isArray(v)
    ? v.map((x, i) => [String(i), x])
    : Object.entries(v as Record<string, unknown>);
  const size = Array.isArray(v) ? `[${entries.length}]` : `{${entries.length}}`;
  if (depth >= w.maxDepth || w.budget.left <= 0)
    return (
      <div key={key} style={pad}>
        {name} {size}{" "}
        <Text span fz="xs" c="dimmed">
          (not shown: too deep or too large)
        </Text>
      </div>
    );
  const open = w.toggled.get(path) ?? depth < w.openDepth;
  const children: ReactNode[] = [];
  let shown = 0;
  if (open)
    for (const [k, x] of entries) {
      if (w.budget.left <= 0) break;
      children.push(node(k, `${path}\u0000${k}`, x, depth + 1, w));
      shown++;
    }
  return (
    <details
      key={key}
      open={open}
      onToggle={(e) => w.toggle(path, e.currentTarget.open)}
      style={pad}
    >
      <summary>
        {name} {size}
      </summary>
      {children}
      {open && shown < entries.length && (
        <Text fz="xs" c="dimmed" pl={12}>
          {entries.length - shown} more not shown
        </Text>
      )}
    </details>
  );
}
