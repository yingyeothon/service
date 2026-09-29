import { Anchor, Table, Text } from "@mantine/core";
import { Link } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { DataTable } from "../components/DataTable";
import { EnumFilter, FilterBar, TextFilter } from "../components/FilterBar";
import { FoldCell } from "../components/FoldCell";
import { AUDIENCE_LABEL } from "../components/ListingSection";
import { PageHeader } from "../components/PageHeader";
import { RowMenu } from "../components/RowMenu";
import { Badge, Notice } from "../components/ui";
import { fmtRelative, fmtTime } from "../lib/format";
import { noMatch, useListQuery } from "../lib/listQuery";
import { notify } from "../lib/notify";
import { useAction, useApiQuery } from "../lib/query";
import {
  CATALOG_PLATFORMS,
  type BrowseListing,
  type CatalogPlatform,
} from "../types";
import { useState } from "react";

/*
 * The one browse page (docs/decisions.md *Catalog listings* #5, #7, #8):
 * every listing the visitor may read — public ones, and signed in, those
 * naming them and their own teams'. No breadcrumbs and no team standing:
 * a listing is read through the listing tables alone.
 *
 * A platform admin reads the admin route instead: every listing whatever
 * its audience, taken-down ones included, in the same columns — a takedown
 * replaces the audience badge (nobody may install it) and the row menu
 * takes it down or clears it. The team keeps editing and unpublishing; only
 * an admin makes a listing readable again.
 */

const NOWRAP = { whiteSpace: "nowrap" } as const;

/** One line, ellipsed at a fixed width (`rules/ui.md` #2). */
const clip = (width: number) =>
  ({
    display: "block",
    width,
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  }) as const;

/** `android 1.4.2` → the CDN file, or the OTA install URL for an iOS ad-hoc build. */
function DownloadLink({
  a,
  title,
}: {
  a: BrowseListing["artifacts"][number];
  title: string;
}) {
  return (
    <Anchor
      href={a.ios?.installUrl ?? a.url}
      size="sm"
      aria-label={`${a.platform} ${a.tags.version ?? ""} of ${title}`.trim()}
    >
      {a.platform}
      {a.tags.version ? ` ${a.tags.version}` : ""}
    </Anchor>
  );
}

/**
 * The newest artifact per platform. One line: the first link inline, the
 * rest behind a `+N` disclosure (seven platforms of long versions would
 * otherwise cost the whole column budget — measured at 732 px).
 */
export function DownloadsCell({ l }: { l: BrowseListing }) {
  if (l.artifacts.length === 0)
    return (
      <Table.Td style={NOWRAP}>
        <Text span size="sm" c="dimmed">
          no build yet
        </Text>
      </Table.Td>
    );
  const [first, ...rest] = l.artifacts;
  return (
    <Table.Td style={NOWRAP}>
      {rest.length === 0 ? (
        <DownloadLink a={first!} title={l.title} />
      ) : (
        <FoldCell
          before={
            <>
              <DownloadLink a={first!} title={l.title} />{" "}
            </>
          }
          label={`+${rest.length}`}
          ariaLabel={`+${rest.length} more downloads of ${l.title}`}
          what={`Every download of ${l.title}`}
          width={40}
          detail={l.artifacts.map((a) => (
            <div key={a.id}>
              <DownloadLink a={a} title={l.title} />
            </div>
          ))}
          // A tooltip cannot be clicked: name the builds, link them in the fold.
          tooltip={l.artifacts
            .map((a) => `${a.platform} ${a.tags.version ?? ""}`.trim())
            .join(" · ")}
        />
      )}
    </Table.Td>
  );
}

/**
 * The title, one line; the summary and every tag fold out under it. An admin
 * row (the one with `takenDown`) also names the app and links its page — the
 * admin handling a complaint knows the app's name, and the app page is a
 * 404 for every other reader (decision #4), so nobody else gets the link.
 */
export function TitleCell({ l }: { l: BrowseListing }) {
  const detail = (
    <>
      <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
        {l.summary ?? "No summary."}
      </Text>
      <Text size="xs" c="dimmed">
        {l.teamName ?? "—"} · published {fmtTime(l.publishedAt)}
      </Text>
      {l.takenDown !== undefined && (
        <Text size="xs" c="dimmed">
          app{" "}
          <Anchor
            component={Link}
            to={`/catalog/apps/${encodeURIComponent(l.appId)}`}
            size="xs"
          >
            {l.appName}
          </Anchor>
        </Text>
      )}
      {l.tags.length > 0 && (
        <Text size="xs" c="dimmed">
          {l.tags.join(", ")}
        </Text>
      )}
    </>
  );
  return (
    <Table.Td style={NOWRAP}>
      <FoldCell
        label={l.title}
        what={`About ${l.title}`}
        width={160}
        detail={detail}
      />
    </Table.Td>
  );
}

/**
 * Who may install it — or, for the admin, that nobody may: a takedown
 * stands in for the audience, with who, when, why and what the audience
 * was folded under it.
 */
function AudienceCell({ l }: { l: BrowseListing }) {
  const t = l.takedown;
  return (
    <Table.Td style={t ? { ...NOWRAP, paddingRight: 24 } : NOWRAP}>
      {t ? (
        <FoldCell
          before={
            <>
              <Badge tone="danger">taken down</Badge>{" "}
            </>
          }
          label={`by ${t.by ?? "—"}`}
          ariaLabel={`by ${t.by ?? "—"}, takedown of ${l.title}`}
          what={`Takedown of ${l.title}`}
          width={100}
          dimmed
          detail={
            <>
              <Text size="sm">
                {fmtTime(t.at)} by {t.by ?? "—"} · was{" "}
                {AUDIENCE_LABEL[l.audience]}
              </Text>
              <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                {t.reason ?? "No reason given."}
              </Text>
            </>
          }
        />
      ) : (
        <Badge tone={l.audience === "public" ? "ok" : "neutral"}>
          {AUDIENCE_LABEL[l.audience]}
        </Badge>
      )}
    </Table.Td>
  );
}

export function ListingsPage() {
  const { me, loading } = useAuth();
  const admin = me?.role === "admin";
  const lq = useListQuery();
  const [platform, setPlatform] = useState<CatalogPlatform | "">("");
  const params = {
    ...lq.params,
    ...(platform ? { platform } : {}),
  };
  const reader = admin ? "admin" : (me?.id ?? null);
  const list = useApiQuery<BrowseListing[]>(
    ["listings", reader, params],
    () =>
      admin ? api.adminCatalogListings(params) : api.catalogListings(params),
    {
      // Keep the rows across a search or sort, never across a change of
      // reader: an admin's members-only rows are no placeholder for the
      // anonymous list after a sign-out on this page.
      keepPrevious: (prev) => prev[1] === reader,
      // Which route answers depends on who asks: wait for the session.
      enabled: !loading,
    },
  );
  const act = useAction();
  const takedown = async (l: BrowseListing, reason?: string) => {
    const r = await act.run(() => api.takedownCatalogListing(l.appId, reason));
    if (!r) return;
    notify.done(`Took down ${l.title}`);
    await list.reload();
  };
  const restore = async (l: BrowseListing) => {
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
        title="Apps"
        description={
          loading ? undefined : !me ? (
            <>
              Apps their teams published for everyone.{" "}
              <Anchor href={api.loginUrl("/listings")}>Sign in</Anchor> to see
              the ones shared with you.
            </>
          ) : admin ? (
            "Every published app, whoever may install it: a members row is visible to the readers its team named. A takedown hides a listing from every reader until an admin clears it; the team may still edit or unpublish it, not republish. Every link is the newest build for that platform."
          ) : (
            "Apps published for everyone, shared with you by name, or published by your own teams. Every link is the newest build for that platform."
          )
        }
      />
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <FilterBar>
        <TextFilter
          value={lq.q}
          onChange={lq.setQ}
          placeholder="Title or summary"
        />
        <EnumFilter
          label="Platform"
          value={platform}
          options={[
            { value: "", label: "Any platform" },
            ...CATALOG_PLATFORMS.map((p) => ({ value: p, label: p })),
          ]}
          onChange={(v) => setPlatform(v as CatalogPlatform | "")}
        />
      </FilterBar>
      <DataTable
        columns={[
          { key: "title", label: "Title", sortKey: "title" },
          { key: "team", label: "Team" },
          { key: "audience", label: "Who may install" },
          { key: "tags", label: "Tags" },
          { key: "downloads", label: "Downloads" },
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
        minWidth={900}
        sort={lq.sort}
        onSort={lq.setSort}
        empty={
          lq.filtering || platform
            ? noMatch(lq.params.q ?? "")
            : { title: "Nothing is published yet." }
        }
        render={(l) => (
          <>
            <TitleCell l={l} />
            <Table.Td style={NOWRAP}>
              <Text span size="sm" style={clip(110)} title={l.teamName ?? ""}>
                {l.teamName ?? "—"}
              </Text>
            </Table.Td>
            <AudienceCell l={l} />
            <Table.Td style={NOWRAP}>
              <Text span size="sm" c="dimmed" style={clip(110)}>
                {l.tags.join(", ") || "—"}
              </Text>
            </Table.Td>
            <DownloadsCell l={l} />
            <Table.Td style={NOWRAP}>
              <Text span size="sm" title={fmtTime(l.publishedAt)}>
                {fmtRelative(l.publishedAt)}
              </Text>
            </Table.Td>
          </>
        )}
        actions={
          admin
            ? (l) => (
                <RowMenu
                  name={l.title}
                  items={[
                    l.takedown
                      ? {
                          label: "Clear takedown",
                          disabled: act.busy,
                          onClick: () => restore(l),
                          confirm: {
                            title: `Clear the takedown of ${l.title}?`,
                            message: "Readers see the listing again at once.",
                            confirmLabel: "Clear takedown",
                          },
                        }
                      : {
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
                  ]}
                />
              )
            : undefined
        }
      />
    </>
  );
}
