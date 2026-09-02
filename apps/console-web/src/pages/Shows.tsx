import {
  Anchor,
  Button,
  SegmentedControl,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import type { ShowAcl, ShowSummary } from "../types";
import { useEffect, useId, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api } from "../api";
import { hasRole, useAuth } from "../auth";
import { DataTable, NameCell } from "../components/DataTable";
import { EnumFilter, FilterBar, TextFilter } from "../components/FilterBar";
import { PageHeader } from "../components/PageHeader";
import { ResourceDrawer, useDrawerForm } from "../components/ResourceDrawer";
import { Badge, Notice } from "../components/ui";
import { fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { noMatch, useListQuery } from "../lib/listQuery";
import { useAction, useApiQuery } from "../lib/query";

/** The "who may see it" choice, on the create and the edit drawer alike. */
export function AclField({
  value,
  onChange,
  description,
}: {
  value: ShowAcl;
  onChange: (v: ShowAcl) => void;
  description?: string;
}) {
  const id = useId();
  return (
    <div>
      <Text size="sm" fw={500} mb={4} id={id}>
        Who may see it
      </Text>
      <SegmentedControl
        aria-labelledby={id}
        value={value}
        onChange={(v) => onChange(v as ShowAcl)}
        data={[
          { value: "public", label: "Everyone" },
          { value: "member_only", label: "Members only" },
        ]}
      />
      {description && (
        <Text size="xs" c="dimmed" mt={4}>
          {description}
        </Text>
      )}
    </div>
  );
}

/**
 * The gallery index. A show belongs to no team, so there are no breadcrumbs
 * and no team standing here: what a visitor may see is the show's own ACL.
 */
export function ShowsPage() {
  const { me, loading } = useAuth();
  const nav = useNavigate();
  const [state, setState] = useState<"all" | "open" | "closed">("all");
  // `q` only: the cursor pins the order, and `q` rides along with `cursor`.
  const lq = useListQuery();
  const filter = {
    ...(state === "all" ? {} : { state }),
    ...(lq.params.q ? { q: lq.params.q } : {}),
  };
  const list = useApiQuery(
    ["shows", state, me?.id ?? null, lq.params],
    () => api.shows(filter),
    { keepPrevious: true },
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
    const page = await act.run(() => api.shows({ ...filter, cursor: next }));
    if (!page) return;
    setMore((prev) => [...prev, ...page.shows]);
    setNext(page.next);
  };
  const create = useDrawerForm<{ title: string; acl: ShowAcl }>(() => ({
    title: "",
    acl: "public",
  }));

  const rows = list.data ? [...list.data.shows, ...more] : undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() =>
      api.createShow({ title: create.form.title.trim(), acl: create.form.acl }),
    );
    if (!r) return;
    create.close();
    notify.created("show");
    void nav(`/shows/${encodeURIComponent(r.id)}`);
  };

  return (
    <>
      <PageHeader
        title="Shows"
        description={
          !loading && !me ? (
            <>
              Public shows are listed here.{" "}
              <Anchor href={api.loginUrl("/shows")}>Sign in</Anchor> to see
              member-only ones and to put your own work up.
            </>
          ) : (
            "A show is a wall where members put up what they built: an app, a bundle or a site, with screenshots."
          )
        }
        actions={
          hasRole(me, "member")
            ? [
                {
                  label: "New show",
                  primary: true,
                  onClick: () => {
                    act.clear();
                    create.open();
                  },
                },
              ]
            : []
        }
      />
      {act.error && !create.opened && <Notice kind="error">{act.error}</Notice>}
      <FilterBar>
        <EnumFilter
          label="State"
          value={state}
          options={[
            { value: "all", label: "All" },
            { value: "open", label: "Open" },
            { value: "closed", label: "Closed" },
          ]}
          onChange={(v) => setState(v as typeof state)}
        />
        <TextFilter value={lq.q} onChange={lq.setQ} placeholder="Title" />
      </FilterBar>
      <DataTable
        columns={[
          { key: "title", label: "Title" },
          { key: "acl", label: "Who may see it" },
          { key: "state", label: "State" },
          { key: "opened", label: "Opened" },
          { key: "owner", label: "Owner" },
        ]}
        rows={rows}
        loading={list.loading}
        fetching={list.fetching}
        error={list.error}
        rowKey={(s) => s.id}
        minWidth={560}
        empty={
          lq.filtering ? noMatch(lq.params.q ?? "") : { title: "No shows." }
        }
        render={(s) => (
          <>
            <NameCell to={`/shows/${encodeURIComponent(s.id)}`}>
              {s.title}
            </NameCell>
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
          </>
        )}
      />
      {(list.data?.next || more.length > 0) && (
        <Button
          variant="default"
          mt="md"
          // A `q` change keeps the old page as placeholder until the new one
          // lands; a click then would pair the old cursor with the new `q`.
          disabled={!next || act.busy || list.fetching}
          onClick={() => void loadMore()}
        >
          {next ? "Load more" : "That is all"}
        </Button>
      )}
      <ResourceDrawer
        opened={create.opened}
        onClose={create.close}
        title="New show"
        submitLabel="Create show"
        onSubmit={submit}
        busy={act.busy}
        disabled={!create.form.title.trim()}
        error={create.opened ? act.error : null}
      >
        <TextInput
          label="Title"
          value={create.form.title}
          onChange={(e) => create.patch({ title: e.currentTarget.value })}
          required
          maxLength={200}
          autoComplete="off"
          data-autofocus
        />
        {/* Chosen at creation (decision 2). Narrowing later is always
            allowed; opening a show to everyone is refused once it has
            entries, so this is the moment that matters. */}
        <AclField
          value={create.form.acl}
          onChange={(acl) => create.patch({ acl })}
          description="Narrowing later is always allowed; opening a show to everyone is refused once it has entries."
        />
      </ResourceDrawer>
    </>
  );
}
