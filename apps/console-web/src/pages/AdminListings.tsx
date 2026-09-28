import { Anchor, Table, Text } from "@mantine/core";
import { Link } from "react-router";
import { api } from "../api";
import { DataTable } from "../components/DataTable";
import { FilterBar, TextFilter } from "../components/FilterBar";
import { FoldCell } from "../components/FoldCell";
import { AUDIENCE_LABEL } from "../components/ListingSection";
import { PageHeader } from "../components/PageHeader";
import { RowMenu } from "../components/RowMenu";
import { Badge, Notice } from "../components/ui";
import { fmtRelative, fmtTime } from "../lib/format";
import { noMatch, useListQuery } from "../lib/listQuery";
import { notify } from "../lib/notify";
import { useAction, useApiQuery } from "../lib/query";
import type { AdminCatalogListing } from "../types";

/*
 * The platform admin's list of every listing (docs/decisions.md *Catalog
 * listings* #8): take one down with a reason, or clear a takedown. The team
 * keeps editing and unpublishing; only this page makes a listing readable
 * again.
 */

const NOWRAP = { whiteSpace: "nowrap" } as const;
const clip = (width: number) =>
  ({
    display: "block",
    width,
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  }) as const;

export function AdminListingsPage() {
  const lq = useListQuery();
  const list = useApiQuery(
    ["admin", "listings", lq.params],
    () => api.adminCatalogListings(lq.params),
    { keepPrevious: true },
  );
  const act = useAction();
  const takedown = async (l: AdminCatalogListing, reason?: string) => {
    const r = await act.run(() => api.takedownCatalogListing(l.appId, reason));
    if (!r) return;
    notify.done(`Took down ${l.title}`);
    await list.reload();
  };
  const restore = async (l: AdminCatalogListing) => {
    const ok = await act.run(async () => {
      await api.restoreCatalogListing(l.appId);
      return true;
    });
    if (!ok) return;
    notify.done(`Cleared the takedown of ${l.title}`);
    await list.reload();
  };
  return (
    <>
      <PageHeader
        title="Listings"
        description="Every published app. A takedown hides a listing from every reader until an admin clears it; the team may still edit or unpublish it, not republish."
      />
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <FilterBar>
        <TextFilter
          value={lq.q}
          onChange={lq.setQ}
          placeholder="Title or summary"
        />
      </FilterBar>
      <DataTable
        columns={[
          { key: "title", label: "Title", sortKey: "title" },
          { key: "app", label: "App" },
          { key: "team", label: "Team" },
          { key: "audience", label: "Who may install" },
          { key: "status", label: "Status" },
          {
            key: "publishedAt",
            label: "Published",
            sortKey: "publishedAt",
            defaultOrder: "desc",
          },
        ]}
        rows={list.data}
        loading={list.loading}
        fetching={list.fetching}
        error={list.error}
        rowKey={(l) => l.appId}
        minWidth={880}
        sort={lq.sort}
        onSort={lq.setSort}
        empty={
          lq.filtering
            ? noMatch(lq.params.q ?? "")
            : { title: "Nothing is published." }
        }
        render={(l) => (
          <>
            <Table.Td style={NOWRAP}>
              <Text span size="sm" fw={500} style={clip(160)} title={l.title}>
                {l.title}
              </Text>
            </Table.Td>
            <Table.Td style={NOWRAP}>
              <Anchor
                component={Link}
                to={`/catalog/apps/${encodeURIComponent(l.appId)}`}
                size="sm"
                style={clip(110)}
              >
                {l.appName}
              </Anchor>
            </Table.Td>
            <Table.Td style={NOWRAP}>
              <Text span size="sm" style={clip(110)} title={l.teamName ?? ""}>
                {l.teamName ?? "—"}
              </Text>
            </Table.Td>
            <Table.Td style={NOWRAP}>
              <Badge tone={l.audience === "public" ? "ok" : "neutral"}>
                {AUDIENCE_LABEL[l.audience]}
              </Badge>
            </Table.Td>
            <Table.Td style={{ ...NOWRAP, paddingRight: 24 }}>
              {l.takedown ? (
                <FoldCell
                  before={
                    <>
                      <Badge tone="danger">taken down</Badge>{" "}
                    </>
                  }
                  label={`by ${l.takedown.by ?? "—"}`}
                  ariaLabel={`by ${l.takedown.by ?? "—"}, takedown of ${l.title}`}
                  what={`Takedown of ${l.title}`}
                  width={100}
                  dimmed
                  detail={
                    <>
                      <Text size="sm">
                        {fmtTime(l.takedown.at)} by {l.takedown.by ?? "—"}
                      </Text>
                      <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                        {l.takedown.reason ?? "No reason given."}
                      </Text>
                    </>
                  }
                />
              ) : (
                <Badge tone="ok">live</Badge>
              )}
            </Table.Td>
            <Table.Td style={NOWRAP}>
              <Text span size="sm" title={fmtTime(l.publishedAt)}>
                {fmtRelative(l.publishedAt)}
              </Text>
            </Table.Td>
          </>
        )}
        actions={(l) => (
          <RowMenu
            name={l.title}
            items={
              l.takedown
                ? [
                    {
                      label: "Clear takedown",
                      disabled: act.busy,
                      onClick: () => restore(l),
                      confirm: {
                        title: `Clear the takedown of ${l.title}?`,
                        message: "Readers see the listing again at once.",
                        confirmLabel: "Clear takedown",
                      },
                    },
                  ]
                : [
                    {
                      label: "Take down",
                      danger: true,
                      disabled: act.busy,
                      onClick: (reason) => takedown(l, reason),
                      confirm: {
                        title: `Take down ${l.title}?`,
                        message:
                          "Every reader loses it until an admin clears the takedown. The team keeps its artifacts.",
                        confirmLabel: "Take down",
                        danger: true,
                        reason: { label: "Reason", required: false },
                      },
                    },
                  ]
            }
          />
        )}
      />
    </>
  );
}
