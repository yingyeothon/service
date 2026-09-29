import {
  Button,
  Group,
  SegmentedControl,
  Table,
  TagsInput,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useId, useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { useAction, useApiQuery } from "../lib/query";
import {
  LISTING_TAG,
  LISTING_TAGS_MAX,
  type CatalogApp,
  type ListingAudience,
} from "../types";
import { DataTable } from "./DataTable";
import { ResourceDrawer, useDrawerForm } from "./ResourceDrawer";
import { RowMenu } from "./RowMenu";
import { Section } from "./Section";
import { Badge, Notice } from "./ui";

/*
 * The publish panel of an app page (docs/decisions.md *Catalog listings*
 * #7): how the app is published, to whom, and the members a `members`
 * listing names. Publishing the app publishes its newest artifact per
 * platform now and for every later upload — the panel says so, because it is
 * the deliberate opposite of a show entry, which pins one build.
 */

const NOWRAP = { whiteSpace: "nowrap" } as const;

export const AUDIENCE_LABEL: Record<ListingAudience, string> = {
  public: "everyone",
  members: "members",
};

interface ListingForm {
  title: string;
  summary: string;
  tags: string[];
  audience: ListingAudience;
}

/** The first tag the grammar refuses, or `null`. */
export const badTag = (tags: string[]): string | null =>
  tags.find((t) => !LISTING_TAG.test(t)) ?? null;

export function AudienceField({
  value,
  onChange,
}: {
  value: ListingAudience;
  onChange: (v: ListingAudience) => void;
}) {
  const id = useId();
  return (
    <div>
      <Text size="sm" fw={500} mb={4} id={id}>
        Who may install it
      </Text>
      <SegmentedControl
        aria-labelledby={id}
        value={value}
        onChange={(v) => onChange(v as ListingAudience)}
        data={[
          { value: "public", label: "Everyone" },
          { value: "members", label: "Named members" },
        ]}
      />
      <Text size="xs" c="dimmed" mt={4}>
        Named members are platform members you add below; they read the newest
        artifacts and nothing else of the project.
      </Text>
    </div>
  );
}

export function ListingSection({
  app,
  canWrite,
}: {
  app: CatalogApp;
  canWrite: boolean;
}) {
  const listing = useApiQuery(
    ["catalog", "app", app.id, "listing"],
    async () => {
      try {
        return await api.catalogListing(app.id);
      } catch (e) {
        // `null` = not published. TanStack Query v5 rejects `undefined`.
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
  );
  const l = listing.data ?? null;
  const viewers = useApiQuery(
    ["catalog", "app", app.id, "listing", "viewers"],
    () => api.catalogListingViewers(app.id),
    { enabled: l !== null },
  );
  const act = useAction();
  const viewerAct = useAction();
  const [login, setLogin] = useState("");
  const edit = useDrawerForm<ListingForm>(() => ({
    title: l?.title ?? app.name,
    summary: l?.summary ?? "",
    tags: l?.tags ?? [],
    audience: l?.audience ?? "public",
  }));
  const tagProblem = badTag(edit.form.tags);
  const formOk =
    edit.form.title.trim() !== "" &&
    tagProblem === null &&
    edit.form.tags.length <= LISTING_TAGS_MAX;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const f = edit.form;
    const r = await act.run(() =>
      api.publishCatalogApp(app.id, {
        title: f.title.trim(),
        summary: f.summary.trim() || null,
        tags: f.tags,
        audience: f.audience,
      }),
    );
    if (!r) return;
    edit.close();
    listing.set(r);
    // The viewers query switches itself on with the first listing row.
    if (l) notify.saved("listing");
    else notify.done("Published");
  };
  const unpublish = async () => {
    const ok = await act.run(async () => {
      await api.unpublishCatalogApp(app.id);
      return true;
    });
    if (!ok) return;
    edit.close();
    listing.set(null);
    await listing.reload();
    notify.done("Unpublished");
  };
  const addViewer = async (e: FormEvent) => {
    e.preventDefault();
    const name = login.trim();
    if (!name) return;
    const r = await viewerAct.run(() =>
      api.addCatalogListingViewer(app.id, name),
    );
    if (!r) return;
    setLogin("");
    notify.done(r.added ? `Added ${r.login}` : `${r.login} was already named`);
    if (r.added) await viewers.reload();
  };
  const removeViewer = async (name: string) => {
    const ok = await viewerAct.run(async () => {
      await api.removeCatalogListingViewer(app.id, name);
      return true;
    });
    if (!ok) return;
    notify.done(`Removed ${name}`);
    await viewers.reload();
  };

  return (
    <Section
      title="Listing"
      description="Publishing puts the app's newest artifact per platform in front of everyone, or of the members you name — now and for every later upload."
      actions={
        canWrite && !listing.loading ? (
          <Button
            variant="default"
            onClick={() => {
              act.clear();
              edit.open();
            }}
          >
            {l ? "Edit listing" : "Publish"}
          </Button>
        ) : undefined
      }
    >
      {act.error && !edit.opened && <Notice kind="error">{act.error}</Notice>}
      {listing.error && <Notice kind="error">{listing.error}</Notice>}
      {listing.data === undefined && !listing.error && (
        <Text size="sm" c="dimmed">
          Loading…
        </Text>
      )}
      {listing.data === null && (
        <Text size="sm" c="dimmed">
          Not published.
        </Text>
      )}
      {l && (
        <>
          {l.takenDown && (
            <Notice kind="warn">
              A platform admin took this listing down: readers cannot see it
              until an admin clears the takedown. You may still edit or
              unpublish it.
            </Notice>
          )}
          <Table variant="vertical" layout="fixed" withTableBorder={false}>
            <Table.Tbody>
              <Table.Tr>
                <Table.Th w={160}>Who may install it</Table.Th>
                <Table.Td>
                  <Badge tone={l.audience === "public" ? "ok" : "neutral"}>
                    {AUDIENCE_LABEL[l.audience]}
                  </Badge>
                </Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Th>Title</Table.Th>
                <Table.Td>{l.title}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Th>Summary</Table.Th>
                <Table.Td style={{ whiteSpace: "pre-wrap" }}>
                  {l.summary ?? "—"}
                </Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Th>Tags</Table.Th>
                <Table.Td>
                  {l.tags.length === 0
                    ? "—"
                    : l.tags.map((t) => (
                        <span key={t}>
                          <Badge tone="neutral">{t}</Badge>{" "}
                        </span>
                      ))}
                </Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Th>Published</Table.Th>
                <Table.Td>
                  {fmtTime(l.publishedAt)} by {l.publishedBy ?? "—"}
                  {l.updatedAt !== l.publishedAt &&
                    ` · edited ${fmtTime(l.updatedAt)}`}
                </Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
          <Text size="sm" fw={500} mt="md" mb="xs" component="h3">
            Named members
          </Text>
          {viewerAct.error && <Notice kind="error">{viewerAct.error}</Notice>}
          {canWrite && (
            <form onSubmit={(e) => void addViewer(e)}>
              <Group align="end" mb="sm" wrap="wrap">
                <TextInput
                  label="GitHub login"
                  value={login}
                  onChange={(e) => setLogin(e.currentTarget.value)}
                  placeholder="octocat"
                  w={220}
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button
                  type="submit"
                  variant="default"
                  disabled={viewerAct.busy || !login.trim()}
                  loading={viewerAct.busy}
                >
                  Add member
                </Button>
              </Group>
            </form>
          )}
          <DataTable
            columns={[
              { key: "login", label: "Login" },
              { key: "by", label: "Added by" },
              { key: "at", label: "Added" },
            ]}
            rows={viewers.data}
            loading={viewers.loading}
            error={viewers.error}
            rowKey={(v) => v.login ?? String(v.addedAt)}
            minWidth={480}
            empty={{
              title:
                l.audience === "members"
                  ? "Nobody is named yet, so nobody outside the team can install it."
                  : "Nobody is named. Everyone may install it already.",
            }}
            render={(v) => (
              <>
                <Table.Td style={NOWRAP}>{v.login ?? "—"}</Table.Td>
                <Table.Td style={NOWRAP}>{v.addedBy ?? "—"}</Table.Td>
                <Table.Td style={NOWRAP}>{fmtTime(v.addedAt)}</Table.Td>
              </>
            )}
            actions={
              canWrite
                ? (v) => (
                    <RowMenu
                      name={v.login ?? "member"}
                      items={[
                        {
                          label: "Remove",
                          danger: true,
                          disabled: viewerAct.busy || v.login === null,
                          onClick: () => removeViewer(v.login ?? ""),
                          confirm: {
                            title: `Remove ${v.login ?? "this member"}?`,
                            message:
                              "Links they already fetched stay valid; they stop seeing new builds.",
                            confirmLabel: "Remove",
                            danger: true,
                          },
                        },
                      ]}
                    />
                  )
                : undefined
            }
          />
        </>
      )}
      <ResourceDrawer
        opened={edit.opened}
        onClose={edit.close}
        title={l ? "Edit listing" : "Publish app"}
        submitLabel={l ? "Save" : "Publish"}
        onSubmit={save}
        busy={act.busy}
        disabled={!formOk}
        error={edit.opened ? act.error : null}
        danger={
          l
            ? {
                label: "Unpublish",
                description:
                  "Readers lose the listing; links they already fetched stay valid.",
                onConfirm: unpublish,
                disabled: act.busy,
                confirmTitle: "Unpublish this app?",
                confirmMessage:
                  "The listing is removed. Named members are forgotten with it.",
              }
            : undefined
        }
      >
        <TextInput
          label="Title"
          value={edit.form.title}
          onChange={(e) => edit.patch({ title: e.currentTarget.value })}
          required
          maxLength={100}
          autoComplete="off"
          data-autofocus
        />
        <Textarea
          label="Summary"
          placeholder="optional, shown to readers"
          value={edit.form.summary}
          onChange={(e) => edit.patch({ summary: e.currentTarget.value })}
          maxLength={2000}
          autosize
          minRows={2}
        />
        <TagsInput
          label="Tags"
          description={`lowercase slugs, up to ${LISTING_TAGS_MAX}`}
          placeholder="rpg, co-op"
          value={edit.form.tags}
          onChange={(tags) =>
            edit.patch({ tags: tags.map((t) => t.trim().toLowerCase()) })
          }
          maxTags={LISTING_TAGS_MAX}
          error={tagProblem ? `"${tagProblem}" is not a slug` : undefined}
        />
        <AudienceField
          value={edit.form.audience}
          onChange={(audience) => edit.patch({ audience })}
        />
      </ResourceDrawer>
    </Section>
  );
}
