import {
  Anchor,
  Button,
  Group,
  SegmentedControl,
  Select,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import type { ShowAcl, ShowSummary } from "../types";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api";
import { hasRole, useAuth } from "../auth";
import { Badge, Notice, Spinner } from "../components/ui";
import { fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";

/**
 * The gallery index. A show belongs to no team, so there are no breadcrumbs
 * and no team standing here: what a visitor may see is the show's own ACL.
 */
export function ShowsPage() {
  const { me, loading } = useAuth();
  const nav = useNavigate();
  const [state, setState] = useState<"all" | "open" | "closed">("all");
  const list = useApiQuery(["shows", state, me?.id ?? null], () =>
    api.shows(state === "all" ? {} : { state }),
  );
  const act = useAction();
  const [more, setMore] = useState<ShowSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  useEffect(() => {
    setMore([]);
    setNext(list.data?.next ?? null);
  }, [list.data]);
  const loadMore = async () => {
    if (!next) return;
    const page = await act.run(() =>
      api.shows({
        ...(state === "all" ? {} : { state }),
        cursor: next,
      }),
    );
    if (!page) return;
    setMore((prev) => [...prev, ...page.shows]);
    setNext(page.next);
  };
  const [title, setTitle] = useState("");
  const [acl, setAcl] = useState<ShowAcl>("public");
  const [creating, setCreating] = useState(false);

  const rows = [...(list.data?.shows ?? []), ...more];

  const create = async () => {
    if (!title.trim()) return;
    const r = await act.run(() => api.createShow({ title: title.trim(), acl }));
    if (!r) return;
    setCreating(false);
    setTitle("");
    void nav(`/shows/${encodeURIComponent(r.id)}`);
  };

  return (
    <>
      <Group justify="space-between" mb="sm">
        <Title order={2}>Shows</Title>
        {hasRole(me, "member") && !creating && (
          <Button onClick={() => setCreating(true)}>New show</Button>
        )}
      </Group>
      {!loading && !me && (
        <Text size="sm" c="dimmed" mb="sm">
          Public shows are listed here.{" "}
          <Anchor href={api.loginUrl("/shows")}>Sign in</Anchor> to see
          member-only ones and to put your own work up.
        </Text>
      )}
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {creating && (
        <Group mb="sm" align="flex-end">
          <TextInput
            label="Title"
            value={title}
            style={{ flex: 1 }}
            onChange={(e) => setTitle(e.currentTarget.value)}
          />
          {/* Chosen at creation (decision 2). Narrowing later is always
              allowed; opening a show to everyone is refused once it has
              entries, so this is the moment that matters. */}
          <Select
            label="Who may see it"
            value={acl}
            onChange={(v) => setAcl((v as ShowAcl | null) ?? "public")}
            data={[
              { value: "public", label: "Everyone" },
              { value: "member_only", label: "Members only" },
            ]}
          />
          <Button onClick={() => void create()} disabled={act.busy}>
            Create
          </Button>
          <Button variant="default" onClick={() => setCreating(false)}>
            Cancel
          </Button>
        </Group>
      )}
      <SegmentedControl
        size="xs"
        mb="sm"
        value={state}
        onChange={(v) => setState(v as typeof state)}
        data={[
          { value: "all", label: "All" },
          { value: "open", label: "Open" },
          { value: "closed", label: "Closed" },
        ]}
      />
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {list.loading && !list.data ? (
        <Spinner />
      ) : rows.length ? (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Title</Table.Th>
              <Table.Th>Who may see it</Table.Th>
              <Table.Th>State</Table.Th>
              <Table.Th>Opened</Table.Th>
              <Table.Th>Owner</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((s) => (
              <Table.Tr key={s.id}>
                <Table.Td>
                  <Anchor
                    component={Link}
                    to={`/shows/${encodeURIComponent(s.id)}`}
                  >
                    {s.title}
                  </Anchor>
                </Table.Td>
                <Table.Td>
                  <Badge tone={s.acl === "public" ? "ok" : "neutral"}>
                    {s.acl === "public" ? "everyone" : "members"}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Badge tone={s.closedAt === null ? "accent" : "neutral"}>
                    {s.closedAt === null ? "open" : "closed"}
                  </Badge>
                </Table.Td>
                <Table.Td>{fmtTime(s.createdAt)}</Table.Td>
                <Table.Td>{s.createdBy ?? "—"}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      ) : (
        <Text size="sm" c="dimmed">
          No shows.
        </Text>
      )}
      {(list.data?.next || more.length > 0) && (
        <Button
          size="compact-sm"
          variant="default"
          mt="xs"
          disabled={!next || act.busy}
          onClick={() => void loadMore()}
        >
          {next ? "Load more" : "That is all"}
        </Button>
      )}
    </>
  );
}
