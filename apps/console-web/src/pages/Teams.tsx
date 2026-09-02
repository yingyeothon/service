import { Anchor, Table, Text, TextInput } from "@mantine/core";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { DataTable, NameCell } from "../components/DataTable";
import { EnumFilter, FilterBar, TextFilter } from "../components/FilterBar";
import { NameDescriptionFields } from "../components/NameDescriptionFields";
import { PageHeader } from "../components/PageHeader";
import { ResourceDrawer, useDrawerForm } from "../components/ResourceDrawer";
import { Badge, Notice } from "../components/ui";
import { fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { noMatch, useListQuery } from "../lib/listQuery";
import { useAction, useApiQuery } from "../lib/query";
import { STANDING_TONE, teamUrl, useInvalidateTeams } from "../lib/team";
import type { RotationHint } from "../types";

/** What `DELETE /teams/{id}/members/{me}` hands back when a member leaves. */
export interface LeftState {
  left: string;
  rotate: RotationHint[];
}

export function RotationNotice({
  rotate,
  who,
}: {
  rotate: RotationHint[];
  who: string;
}) {
  if (rotate.length === 0) return null;
  return (
    <Notice kind="warn">
      <Text size="sm">
        {who} still knows the credentials of these channels — nothing was
        revoked, because a rotation mid-game kills it. Rotate them when it is
        safe:
      </Text>
      <Text size="sm">
        {rotate.map((c, i) => (
          <span key={c.id}>
            {i > 0 && ", "}
            <Anchor
              component={Link}
              to={`/channels/${encodeURIComponent(c.id)}`}
              size="sm"
            >
              {c.name}
            </Anchor>{" "}
            ({c.kind})
          </span>
        ))}
      </Text>
    </Notice>
  );
}

export function TeamsPage() {
  const { me } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [all, setAll] = useState(false);
  const lq = useListQuery();
  const list = useApiQuery(
    ["teams", all ? "all" : "mine", lq.params],
    () => api.teams(all ? "all" : undefined, lq.params),
    { keepPrevious: true },
  );
  const invalidateTeams = useInvalidateTeams();
  const act = useAction();
  const create = useDrawerForm(() => ({ name: "", description: "" }));
  const join = useDrawerForm(() => ({ name: "" }));
  // Captured once: the history entry is scrubbed right after, so a reload or
  // back/forward never resurrects the rotation list.
  const [left] = useState<LeftState | null>(
    () => (loc.state as LeftState | null) ?? null,
  );
  useEffect(() => {
    if ((loc.state as LeftState | null)?.left)
      void nav(loc.pathname, { replace: true, state: null });
  }, [loc.state, loc.pathname, nav]);

  const submitCreate = async (e: FormEvent) => {
    e.preventDefault();
    const description = create.form.description.trim();
    const r = await act.run(() =>
      api.createTeam({
        name: create.form.name.trim(),
        ...(description ? { description } : {}),
      }),
    );
    if (!r) return;
    create.close();
    notify.created("team");
    // The navigation's team list is another query key.
    void invalidateTeams();
    void nav(teamUrl(r.id));
  };
  const submitJoin = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() => api.joinTeam(join.form.name.trim()));
    if (!r) return;
    join.close();
    notify.done(`Requested to join ${r.name}; an owner has to approve it`);
    await invalidateTeams();
  };

  return (
    <>
      <PageHeader
        title="Teams"
        description="A team owns projects; a project owns channels, catalog apps, asset bundles and sites. Every member of a team may read and write all of it. There is no public list of teams: ask an owner to add you, or request to join by the exact name."
        actions={[
          {
            label: "New team",
            primary: true,
            onClick: () => {
              act.clear();
              create.open();
            },
          },
          {
            label: "Request to join",
            onClick: () => {
              act.clear();
              join.open();
            },
          },
        ]}
      />
      {left && (
        <>
          <Notice kind="success">You left {left.left}.</Notice>
          <RotationNotice rotate={left.rotate} who="You" />
        </>
      )}
      <FilterBar>
        <TextFilter
          value={lq.q}
          onChange={lq.setQ}
          placeholder="Name or description"
        />
        {me?.role === "admin" && (
          <EnumFilter
            label="Scope"
            value={all ? "all" : "mine"}
            options={[
              { value: "mine", label: "Mine" },
              { value: "all", label: "Every team" },
            ]}
            onChange={(v) => {
              // The every-team listing has no seat: the server refuses sort=role.
              if (v === "all" && lq.sort?.key === "role") lq.setSort(null);
              setAll(v === "all");
            }}
          />
        )}
      </FilterBar>
      <DataTable
        columns={[
          { key: "name", label: "Team", sortKey: "name" },
          // The admin's every-team listing has no seat to order by.
          {
            key: "role",
            label: "Your role",
            sortKey: all ? undefined : "role",
          },
          { key: "by", label: "Created by", sortKey: "createdBy" },
          {
            key: "updated",
            label: "Updated",
            sortKey: "updatedAt",
            defaultOrder: "desc",
          },
        ]}
        rows={list.data}
        loading={list.loading}
        fetching={list.fetching}
        error={list.error}
        sort={lq.sort}
        onSort={lq.setSort}
        rowKey={(t) => t.id}
        minWidth={480}
        empty={
          lq.filtering
            ? noMatch(lq.params.q ?? "")
            : {
                title: "You are not in any team yet.",
                hint: "Create one, or request to join by its exact name.",
              }
        }
        render={(t) => (
          <>
            <NameCell
              to={teamUrl(t.id)}
              after={
                t.adminLocked && (
                  <>
                    {" "}
                    <Badge tone="danger">admin-locked</Badge>
                  </>
                )
              }
            >
              {t.name}
            </NameCell>
            <Table.Td>
              <Badge tone={STANDING_TONE[t.role]}>{t.role}</Badge>
            </Table.Td>
            <Table.Td>{t.createdBy ?? "—"}</Table.Td>
            <Table.Td>{fmtTime(t.updatedAt)}</Table.Td>
          </>
        )}
      />
      <ResourceDrawer
        opened={create.opened}
        onClose={create.close}
        title="New team"
        submitLabel="Create team"
        onSubmit={submitCreate}
        busy={act.busy}
        disabled={!create.form.name.trim()}
        error={create.opened ? act.error : null}
      >
        <NameDescriptionFields
          name={create.form.name}
          description={create.form.description}
          onName={(name) => create.patch({ name })}
          onDescription={(description) => create.patch({ description })}
          namePlaceholder="my-studio"
          markdown
        />
      </ResourceDrawer>
      <ResourceDrawer
        opened={join.opened}
        onClose={join.close}
        title="Request to join"
        submitLabel="Request"
        onSubmit={submitJoin}
        busy={act.busy}
        disabled={!join.form.name.trim()}
        error={join.opened ? act.error : null}
      >
        <TextInput
          label="Team name"
          description="The exact name; an owner approves the request."
          value={join.form.name}
          onChange={(e) => join.patch({ name: e.currentTarget.value })}
          required
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          data-autofocus
        />
      </ResourceDrawer>
    </>
  );
}
