import { Anchor, Table, Text } from "@mantine/core";
import { api } from "../api";
import { useAuth } from "../auth";
import { DataTable } from "../components/DataTable";
import { EnumFilter, FilterBar, TextFilter } from "../components/FilterBar";
import { FoldCell } from "../components/FoldCell";
import { AUDIENCE_LABEL } from "../components/ListingSection";
import { PageHeader } from "../components/PageHeader";
import { Badge } from "../components/ui";
import { fmtRelative, fmtTime } from "../lib/format";
import { noMatch, useListQuery } from "../lib/listQuery";
import { useApiQuery } from "../lib/query";
import {
  CATALOG_PLATFORMS,
  type CatalogPlatform,
  type PublicListing,
} from "../types";
import { useState } from "react";

/*
 * The public browse page (docs/decisions.md *Catalog listings* #5, #7):
 * every listing the visitor may read — public ones, and signed in, those
 * naming them and their own teams'. No breadcrumbs and no team standing:
 * a listing is read through the listing tables alone.
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
  a: PublicListing["artifacts"][number];
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
export function DownloadsCell({ l }: { l: PublicListing }) {
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

/** The title, one line; the summary and every tag fold out under it. */
export function TitleCell({ l }: { l: PublicListing }) {
  const detail = (
    <>
      <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
        {l.summary ?? "No summary."}
      </Text>
      <Text size="xs" c="dimmed">
        {l.teamName ?? "—"} · published {fmtTime(l.publishedAt)}
      </Text>
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

export function ListingsPage() {
  const { me, loading } = useAuth();
  const lq = useListQuery();
  const [platform, setPlatform] = useState<CatalogPlatform | "">("");
  const params = {
    ...lq.params,
    ...(platform ? { platform } : {}),
  };
  const list = useApiQuery(
    ["listings", me?.id ?? null, params],
    () => api.catalogListings(params),
    { keepPrevious: true },
  );
  return (
    <>
      <PageHeader
        title="Apps"
        description={
          !loading && !me ? (
            <>
              Apps their teams published for everyone.{" "}
              <Anchor href={api.loginUrl("/listings")}>Sign in</Anchor> to see
              the ones shared with you.
            </>
          ) : (
            "Apps published for everyone, shared with you by name, or published by your own teams. Every link is the newest build for that platform."
          )
        }
      />
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
          lq.filtering
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
            <Table.Td style={NOWRAP}>
              <Badge tone={l.audience === "public" ? "ok" : "neutral"}>
                {AUDIENCE_LABEL[l.audience]}
              </Badge>
            </Table.Td>
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
      />
    </>
  );
}
