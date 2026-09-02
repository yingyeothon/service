import { Anchor, Code, Table, Text } from "@mantine/core";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { DataTable, NameCell } from "../components/DataTable";
import { EnumFilter, FilterBar, TextFilter } from "../components/FilterBar";
import { PageHeader } from "../components/PageHeader";
import { RowMenu } from "../components/RowMenu";
import { Badge, Notice } from "../components/ui";
import { fmtRelative, fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { noMatch, useListQuery } from "../lib/listQuery";
import { useAction, useApiQuery } from "../lib/query";
import { projectUrl } from "../lib/team";
import type { ChannelKind, ChannelStatus } from "../types";

const STATUS_TONE: Record<ChannelStatus, string> = {
  active: "ok",
  expired: "warn",
  disabled: "danger",
};

/** Every channel across the caller's teams; creation happens on a project page. */
export function ChannelsPage() {
  const { me } = useAuth();
  const [kind, setKind] = useState<ChannelKind | "">("");
  const [all, setAll] = useState(false);
  const lq = useListQuery();
  const list = useApiQuery(
    ["channels", kind, all, lq.params],
    () =>
      api.channels({
        kind: kind || undefined,
        scope: all ? "all" : undefined,
        ...lq.params,
      }),
    { keepPrevious: true },
  );
  const act = useAction();
  const extend = async (id: string) => {
    if (await act.run(() => api.extendChannel(id))) {
      notify.done("Channel extended");
      await list.reload();
    }
  };
  const remove = async (id: string) => {
    if (
      await act.run(async () => {
        await api.deleteChannel(id);
        return true;
      })
    ) {
      notify.deleted("channel");
      await list.reload();
    }
  };
  return (
    <>
      <PageHeader
        title="Channels"
        description={
          <>
            Every channel of every team you sit in. New channels are created
            from a project&rsquo;s <b>Channels</b> tab (
            <Anchor component={Link} to="/teams">
              Teams
            </Anchor>
            ). Channels expire 7 days after creation; extend them from the
            detail page (up to 28 days ahead). Expired channels are disabled,
            then deleted 30 days later.
          </>
        }
      />
      <FilterBar>
        <EnumFilter
          label="Kind"
          value={kind}
          options={[
            { value: "", label: "All kinds" },
            { value: "auth", label: "auth" },
            { value: "topic", label: "topic" },
            { value: "match", label: "match" },
            { value: "lobby", label: "lobby" },
            { value: "q", label: "q" },
          ]}
          onChange={(v) => setKind(v as ChannelKind | "")}
        />
        {me?.role === "admin" && (
          <EnumFilter
            label="Scope"
            value={all ? "all" : "mine"}
            options={[
              { value: "mine", label: "My teams" },
              { value: "all", label: "Every team" },
            ]}
            onChange={(v) => setAll(v === "all")}
          />
        )}
        <TextFilter
          value={lq.q}
          onChange={lq.setQ}
          placeholder="Channel or project name"
        />
      </FilterBar>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <DataTable
        columns={[
          { key: "name", label: "Name", sortKey: "name" },
          { key: "kind", label: "Kind", sortKey: "kind" },
          { key: "project", label: "Project", sortKey: "projectName" },
          { key: "id", label: "Id", sortKey: "id" },
          { key: "status", label: "Status", sortKey: "status" },
          {
            key: "expires",
            label: "Expires",
            sortKey: "expiresAt",
            defaultOrder: "desc",
          },
        ]}
        rows={list.data}
        loading={list.loading}
        fetching={list.fetching}
        error={list.error}
        sort={lq.sort}
        onSort={lq.setSort}
        rowKey={(c) => c.id}
        minWidth={640}
        empty={
          lq.filtering
            ? noMatch(lq.params.q ?? "")
            : {
                title: "No channels yet.",
                hint: "Create one from a project's Channels tab.",
              }
        }
        render={(c) => (
          <>
            <NameCell to={`/channels/${encodeURIComponent(c.id)}`}>
              {c.name}
            </NameCell>
            <Table.Td>{c.kind}</Table.Td>
            <Table.Td>
              {c.teamId && c.projectId ? (
                <Anchor
                  component={Link}
                  to={projectUrl(c.teamId, c.projectId)}
                  size="sm"
                >
                  {c.teamName ?? c.teamId} / {c.projectName ?? c.projectId}
                </Anchor>
              ) : (
                <Text size="sm" c="dimmed">
                  unassigned
                </Text>
              )}
            </Table.Td>
            <Table.Td>
              <Code>{c.id}</Code>
            </Table.Td>
            <Table.Td>
              <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
            </Table.Td>
            <Table.Td title={fmtTime(c.expiresAt)}>
              {fmtRelative(c.expiresAt)}
            </Table.Td>
          </>
        )}
        actions={(c) => (
          <RowMenu
            name={c.name}
            items={[
              {
                label: "Extend +7 days",
                onClick: () => extend(c.id),
                disabled: act.busy,
              },
              {
                label: "Delete channel",
                danger: true,
                disabled: act.busy,
                onClick: () => remove(c.id),
                confirm: {
                  title: `Delete ${c.name}?`,
                  message:
                    "Sockets on it are closed and its credentials stop working.",
                  confirmLabel: "Delete channel",
                  danger: true,
                },
              },
            ]}
          />
        )}
      />
    </>
  );
}
