import {
  Button,
  Code,
  Collapse,
  Group,
  NumberInput,
  Table,
  Text,
  TextInput,
  Textarea,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useId, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api, ApiError } from "../api";
import { Crumbs } from "../components/Crumbs";
import { DataTable, NumCell } from "../components/DataTable";
import { FilterBar, TextFilter } from "../components/FilterBar";
import { PageSkeleton } from "../components/Loading";
import { NameDescriptionFields } from "../components/NameDescriptionFields";
import { PageHeader, type HeaderAction } from "../components/PageHeader";
import { ReadOnlyBanner } from "../components/ReadOnlyBanner";
import { ResourceDrawer, useDrawerForm } from "../components/ResourceDrawer";
import { RowMenu } from "../components/RowMenu";
import { Section } from "../components/Section";
import { Badge, CopyBlock, CopyField, Notice } from "../components/ui";
import { useConfirm } from "../lib/confirm";
import { fmtRelative, fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { useAction, useApiQuery } from "../lib/query";
import { projectUrl, useTeamStanding } from "../lib/team";
import type { KvCollection, KvEntry, KvEntryQuery, KvScope } from "../types";

/*
 * A kv collection is a project resource (`docs/decisions.md` *Key-value store
 * (`kv`)*): the console shows its shape and its entries and lets a member
 * write plaintext values; a game reaches the same rows through the KV API on
 * the state stack. Everything the server refuses — a value in an encrypted
 * collection, a changed scope, a key the grammar rejects — is refused here
 * before the request, with the same words.
 */

export const kvUrl = (id: string) => `/kv/${encodeURIComponent(id)}`;

/** Mirrors `KV_KEY_RE` in `@yyt/console-db`. */
export const KV_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Hard caps of `checkKvCaps`; the defaults are the form's initial values. */
export const KV_MAX_ENTRIES_HARD = 100_000;
export const KV_MAX_ENTRIES_PER_OWNER_HARD = 1_000;
export const KV_MAX_ENTRIES_DEFAULT = 10_000;
export const KV_MAX_ENTRIES_PER_OWNER_DEFAULT = 100;

export const KV_SCOPE_LABEL: Record<KvScope, string> = {
  team: "team — console and CLI only",
  project: "project — every player and the server key",
  user: "user — each player its own namespace",
};

/** What the form says before the server would (`checkKvScopes`). */
export function kvShapeProblem(
  read: KvScope,
  write: KvScope,
  encrypted: boolean,
): string | null {
  if (read === "user" && write !== "user")
    return "A user read scope needs a user write scope: only a per-owner namespace can be read per owner.";
  if (encrypted && (read === "team" || write === "team"))
    return "An encrypted collection needs project or user scopes: the key that opens it lives in the state stack, which a team scope never reaches.";
  return null;
}

/** The one shape whose consequence is easy to miss. */
export const KV_PUBLIC_PROFILE_WARNING =
  "project-read + user-write lets every player list every owner's entries.";
export const KV_IMMUTABLE_NOTE =
  "Scopes and encryption cannot be changed later; delete and recreate the collection to change them.";

export const isUserNamespace = (c: Pick<KvCollection, "writeScope">) =>
  c.writeScope === "user";

export function ScopeBadges({
  col,
}: {
  col: Pick<KvCollection, "readScope" | "writeScope" | "encrypted">;
}) {
  return (
    <>
      <Badge tone="neutral">read: {col.readScope}</Badge>
      <Badge tone="neutral">write: {col.writeScope}</Badge>
      {col.encrypted && <Badge tone="accent">encrypted</Badge>}
    </>
  );
}

/**
 * One line, ellipsed at a fixed width (`max-width` on a `td` of an
 * auto-layout table does not hold, `rules/ui.md`). The full text is a
 * tooltip for the pointer and, for a tap or a keyboard, a fold inside the
 * cell where it is selectable — an owner id is 32 hex and always clipped,
 * and it is what a member types into the filter or `--owner`.
 */
function Clipped({
  text,
  width,
  what,
}: {
  text: string;
  width: number;
  /** The fold's accessible name: "Full key". */
  what: string;
}) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const foldId = useId();
  return (
    <>
      <Tooltip
        label={text}
        multiline
        w={Math.max(width, 320)}
        position="top-start"
        events={{ hover: !open, focus: !open, touch: false }}
        opened={open || armed ? false : undefined}
      >
        <UnstyledButton
          onClick={() => {
            setOpen((o) => !o);
            setArmed(true);
          }}
          onMouseLeave={() => setArmed(false)}
          onBlur={() => setArmed(false)}
          aria-expanded={open}
          aria-controls={foldId}
          style={{ display: "block", width, cursor: "pointer" }}
        >
          <Code
            style={{
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {text}
          </Code>
        </UnstyledButton>
      </Tooltip>
      <Collapse in={open}>
        <Code
          block
          id={foldId}
          role="group"
          aria-label={what}
          mt={4}
          style={{
            maxWidth: Math.max(width, 320),
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            userSelect: "all",
          }}
        >
          {text}
        </Code>
      </Collapse>
    </>
  );
}

const jsonProblem = (text: string): string | null => {
  if (text.trim() === "") return "A value is required (JSON; `null` counts).";
  try {
    JSON.parse(text);
    return null;
  } catch {
    return "Not valid JSON.";
  }
};

/**
 * The entries of one collection, cursor-paged. The first page is a query
 * (so a filter change refetches and a write reloads it); the pages after it
 * are appended locally and dropped whenever the filters or the first page
 * change, which is what keeps a reloaded table from showing stale rows
 * below fresh ones.
 */
function useEntries(id: string, filters: KvEntryQuery, enabled: boolean) {
  const first = useApiQuery(
    ["kv", id, "entries", filters],
    () => api.kvEntries(id, filters),
    { enabled, keepPrevious: true },
  );
  const [extra, setExtra] = useState<{
    of: unknown;
    rows: KvEntry[];
    next?: string;
  } | null>(null);
  const more = useAction();
  const live = extra && extra.of === first.data ? extra : null;
  const rows = first.data
    ? live
      ? [...first.data.entries, ...live.rows]
      : first.data.entries
    : undefined;
  const next = live ? live.next : first.data?.nextCursor;
  const loadMore = async () => {
    // While page one is refetching under new filters, `next` is still the
    // old listing's cursor: a click now would mix the two.
    if (!next || !first.data || first.fetching) return;
    const page = await more.run(() =>
      api.kvEntries(id, { ...filters, cursor: next }),
    );
    if (!page) return;
    const of = first.data;
    setExtra({
      of,
      rows: [...(live?.rows ?? []), ...page.entries],
      next: page.nextCursor,
    });
  };
  // A reload drops the appended pages by hand as well: TanStack keeps the
  // same `data` object when a refetch returns equal content (structural
  // sharing), so an edit on a later page would otherwise stay on screen.
  const reload = async () => {
    setExtra(null);
    more.clear();
    await first.reload();
  };
  return {
    rows,
    next,
    loading: first.loading,
    fetching: first.fetching,
    error: first.error ?? more.error,
    busy: more.busy,
    loadMore,
    reload,
  };
}

interface EntryForm {
  mode: "create" | "edit";
  owner: string;
  key: string;
  valueText: string;
  /** `NumberInput` hands back `""` for an empty field. */
  ttl: number | string;
  /** The version an edit was opened on: sent as `ifVersion`. */
  version: number;
}

export function KvCollectionPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const q = useApiQuery(["kv", id], () => api.kv(id));
  const col = q.data;
  const standing = useTeamStanding(col?.teamId);
  const act = useAction();
  const confirm = useConfirm();
  const edit = useDrawerForm<{
    name: string;
    description: string;
    maxEntries: CapValue;
    maxEntriesPerOwner: CapValue;
  }>(() => ({
    name: col?.name ?? "",
    description: col?.description ?? "",
    maxEntries: col?.maxEntries ?? KV_MAX_ENTRIES_DEFAULT,
    maxEntriesPerOwner:
      col?.maxEntriesPerOwner ?? KV_MAX_ENTRIES_PER_OWNER_DEFAULT,
  }));

  // The entry filters: both are request parameters, debounced like a search.
  const [prefix, setPrefix] = useState("");
  const [owner, setOwner] = useState("");
  const [prefixD] = useDebouncedValue(prefix.trim(), 300);
  const [ownerD] = useDebouncedValue(owner.trim(), 300);
  const userNs = col ? isUserNamespace(col) : false;
  const filters: KvEntryQuery = {
    ...(prefix.trim() === "" || prefixD === "" ? {} : { prefix: prefixD }),
    ...(!userNs || owner.trim() === "" || ownerD === ""
      ? {}
      : { owner: ownerD }),
  };
  const entries = useEntries(id, filters, !!col);

  const entryForm = useDrawerForm<EntryForm>(() => ({
    mode: "create",
    owner: userNs ? ownerD : "",
    key: "",
    valueText: "",
    ttl: "",
    version: 0,
  }));
  const entryAct = useAction();

  const crumbs = <Crumbs crumbs={col ?? {}} current={col?.name} />;
  if (q.error)
    return (
      <>
        {crumbs}
        <PageHeader />
        <Notice kind="error">{q.error}</Notice>
      </>
    );
  if (!col)
    return (
      <>
        {crumbs}
        <PageHeader />
        <PageSkeleton />
      </>
    );

  const canWrite = standing.canWrite;
  // A seatless admin sees keys and sizes, never a value (`team-access.ts`);
  // the server withholds `valueText`, and the column waits for the standing
  // rather than paint blanks meanwhile. Per row, `Edit` follows the response.
  const showValues =
    !col.encrypted && !standing.loading && standing.standing !== "admin";

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body: {
      name?: string;
      description?: string | null;
      maxEntries?: number;
      maxEntriesPerOwner?: number;
    } = {};
    const name = edit.form.name.trim();
    if (name !== col.name) body.name = name;
    const desc = edit.form.description.trim();
    if (desc !== (col.description ?? "")) body.description = desc || null;
    const { maxEntries, maxEntriesPerOwner } = edit.form;
    if (
      !capOk(maxEntries, KV_MAX_ENTRIES_HARD) ||
      !capOk(maxEntriesPerOwner, KV_MAX_ENTRIES_PER_OWNER_HARD)
    )
      return;
    if (maxEntries !== col.maxEntries) body.maxEntries = maxEntries;
    if (maxEntriesPerOwner !== col.maxEntriesPerOwner)
      body.maxEntriesPerOwner = maxEntriesPerOwner;
    if (Object.keys(body).length === 0) {
      edit.close();
      return;
    }
    const r = await act.run(() => api.updateKv(id, body));
    if (!r) return;
    // PATCH answers the row without the live count; keep the one we have.
    q.set({ ...r, entries: col.entries });
    edit.close();
    notify.saved("collection");
  };
  const remove = async () => {
    const ok = await act.run(async () => {
      await api.deleteKv(id);
      return true;
    });
    if (!ok) return;
    notify.deleted("collection");
    void navigate(
      col.teamId && col.projectId
        ? projectUrl(col.teamId, col.projectId, "kv")
        : "/teams",
    );
  };

  const openCreate = () => {
    entryAct.clear();
    entryForm.open();
  };
  const openEdit = (row: KvEntry) => {
    entryAct.clear();
    entryForm.open();
    entryForm.setForm({
      mode: "edit",
      owner: row.owner ?? "",
      key: row.key,
      valueText: row.valueText ?? "",
      ttl: "",
      version: row.version,
    });
  };
  const f = entryForm.form;
  const keyProblem =
    f.key === ""
      ? "A key is required."
      : KV_KEY_RE.test(f.key)
        ? null
        : "A key is 1–128 of A–Z a–z 0–9 . _ : - and starts with a letter or digit.";
  const ownerProblem =
    userNs && f.owner.trim() === ""
      ? "This collection keeps one namespace per owner; name the owner."
      : null;
  const valueProblem = jsonProblem(f.valueText);
  const ttlNumber = f.ttl === "" ? undefined : Number(f.ttl);
  const submitEntry = async (e: FormEvent) => {
    e.preventDefault();
    if (keyProblem || ownerProblem || valueProblem) return;
    const r = await entryAct.run(async () => {
      try {
        return await api.putKvEntry(id, f.key, {
          ...(userNs ? { owner: f.owner.trim() } : {}),
          valueText: f.valueText,
          ...(ttlNumber === undefined ? {} : { ttl: ttlNumber }),
          ...(f.mode === "edit" ? { ifVersion: f.version } : {}),
        });
      } catch (e) {
        // A compare-and-set miss names the version that won; the row on
        // screen is stale, so refresh it — the drawer still holds the old
        // version and would miss again until reopened.
        if (e instanceof ApiError && e.code === "conflict") {
          const current = (e.details as { current?: unknown } | undefined)
            ?.current;
          void entries.reload();
          throw new Error(
            `${e.message} — the entry is now at version ${typeof current === "number" ? current : "(deleted)"}; close and reopen it to edit the current value`,
          );
        }
        throw e;
      }
    });
    if (!r) return;
    entryForm.close();
    if (r.created) notify.created("entry");
    else notify.saved("entry");
    await Promise.all([entries.reload(), q.reload()]);
  };
  const removeEntry = async (row: KvEntry) => {
    if (
      await entryAct.run(async () => {
        await api.deleteKvEntry(id, row.key, row.owner);
        return true;
      })
    ) {
      notify.deleted("entry");
      await Promise.all([entries.reload(), q.reload()]);
    }
  };
  const clearOwner = async () => {
    const target = owner.trim();
    const r = await confirm({
      title: `Clear ${target}?`,
      message: `Every entry of owner ${target} in this collection is deleted.`,
      confirmLabel: "Clear owner",
      danger: true,
    });
    if (!r.ok) return;
    const res = await entryAct.run(() => api.deleteKvOwner(id, target));
    if (!res) return;
    notify.done(
      res.truncated
        ? `${res.deleted} entries deleted; more remain, clear again`
        : `${res.deleted} entries deleted`,
    );
    await Promise.all([entries.reload(), q.reload()]);
  };

  const actions: HeaderAction[] = canWrite
    ? [
        {
          label: "Edit",
          onClick: () => {
            act.clear();
            edit.open();
          },
        },
      ]
    : [];
  const rowLabel = (r: KvEntry) => (r.owner ? `${r.owner} ${r.key}` : r.key);
  const apiLines: (readonly [string, string])[] = [
    ["base", col.api.baseUrl],
    ["meta", col.api.metaPath],
    ["entries", col.api.entriesPath],
    ...(col.api.ownerPath ? [["owner", col.api.ownerPath] as const] : []),
  ];

  return (
    <>
      {crumbs}
      <PageHeader
        title={col.name}
        badges={<ScopeBadges col={col} />}
        description={col.description ?? undefined}
        meta={
          <>
            {col.entries} entr{col.entries === 1 ? "y" : "ies"} · at most{" "}
            {col.maxEntries}
            {userNs ? ` (${col.maxEntriesPerOwner} per owner)` : ""} · Created
            by {col.createdBy ?? "—"} · {fmtTime(col.createdAt)} · id{" "}
            <Code>{col.id}</Code>
          </>
        }
        actions={actions}
      />
      {!canWrite && !standing.loading && <ReadOnlyBanner />}
      {col.encrypted && (
        <Notice>
          Encrypted: values are written and read only through the KV API. The
          console shows keys, owners, sizes and times, and can delete.
        </Notice>
      )}
      {act.error && !edit.opened && <Notice kind="error">{act.error}</Notice>}
      <Section
        title="API"
        description={
          col.readScope === "team" && col.writeScope === "team"
            ? "Both scopes are team: the KV API refuses every read and write here; use the console or `yyt kv`."
            : "A game server sends the project's document API key (an auth channel's, issued on the channel page); a player sends the channel JWT it already holds. `If-Match` on a write is a compare-and-set."
        }
      >
        {!col.api.configured && (
          <Notice kind="warn">
            This stage has no state stack deployed, so the KV API does not
            answer here yet; the paths are the ones it will serve.
          </Notice>
        )}
        <CopyBlock label="KV API" lines={apiLines} />
      </Section>
      <Section
        title="Entries"
        description={
          userNs
            ? "One namespace per owner: filter by owner to see one player's rows, or leave it empty for every owner."
            : "One shared namespace."
        }
        actions={
          canWrite && (
            <>
              {userNs && (
                <Button
                  variant="default"
                  disabled={
                    owner.trim() === "" ||
                    owner.trim() !== ownerD ||
                    entryAct.busy
                  }
                  onClick={() => void clearOwner()}
                >
                  Clear owner
                </Button>
              )}
              {!col.encrypted && (
                <Button variant="default" onClick={openCreate}>
                  New entry
                </Button>
              )}
            </>
          )
        }
      >
        <FilterBar>
          <TextFilter
            label="Key prefix"
            value={prefix}
            onChange={setPrefix}
            placeholder="prefix"
          />
          {userNs && (
            <TextFilter
              label="Owner"
              value={owner}
              onChange={setOwner}
              placeholder="owner id"
            />
          )}
        </FilterBar>
        {entryAct.error && !entryForm.opened && (
          <Notice kind="error">{entryAct.error}</Notice>
        )}
        <DataTable
          columns={[
            { key: "key", label: "Key" },
            ...(userNs ? [{ key: "owner", label: "Owner" }] : []),
            ...(showValues ? [{ key: "value", label: "Value" }] : []),
            { key: "bytes", label: "Bytes", align: "right" as const },
            { key: "version", label: "Version", align: "right" as const },
            { key: "expires", label: "Expires" },
            { key: "updated", label: "Updated" },
          ]}
          rows={entries.rows}
          loading={entries.loading}
          fetching={entries.fetching}
          error={entries.error}
          rowKey={(r) => `${r.owner ?? ""}\0${r.key}`}
          minWidth={userNs || showValues ? 720 : 560}
          empty={{
            title: prefix || owner ? "No entries match." : "No entries yet.",
            hint:
              prefix || owner
                ? "Clear the filters to see everything."
                : col.encrypted
                  ? "Values arrive through the KV API."
                  : canWrite
                    ? "Put one from here, `yyt kv entry put`, or the KV API."
                    : undefined,
          }}
          render={(r) => (
            <>
              <Table.Td>
                <Clipped text={r.key} width={180} what="Full key" />
              </Table.Td>
              {userNs && (
                <Table.Td>
                  <Clipped text={r.owner ?? ""} width={140} what="Full owner" />
                </Table.Td>
              )}
              {showValues && (
                <Table.Td>
                  <Clipped
                    text={r.valueText ?? ""}
                    width={220}
                    what="Full value"
                  />
                </Table.Td>
              )}
              <NumCell>{r.bytes}</NumCell>
              <NumCell>{r.version}</NumCell>
              <Table.Td
                title={r.expiresAt === null ? undefined : fmtTime(r.expiresAt)}
              >
                {r.expiresAt === null ? "—" : fmtRelative(r.expiresAt)}
              </Table.Td>
              <Table.Td title={fmtTime(r.updatedAt)}>
                {fmtRelative(r.updatedAt)}
              </Table.Td>
            </>
          )}
          actions={
            canWrite
              ? (r) => (
                  <RowMenu
                    name={rowLabel(r)}
                    items={[
                      ...(showValues && r.valueText !== undefined
                        ? [
                            {
                              label: "Edit entry",
                              disabled: entryAct.busy,
                              onClick: () => openEdit(r),
                            },
                          ]
                        : []),
                      {
                        label: "Delete entry",
                        danger: true,
                        disabled: entryAct.busy,
                        onClick: () => removeEntry(r),
                        confirm: {
                          title: `Delete ${rowLabel(r)}?`,
                          message:
                            "The key is free again; its version continues if it is written again.",
                          confirmLabel: "Delete entry",
                          danger: true,
                        },
                      },
                    ]}
                  />
                )
              : undefined
          }
        />
        {entries.next && (
          <Group mt="sm">
            <Button
              variant="default"
              size="compact-sm"
              loading={entries.busy}
              disabled={entries.fetching}
              onClick={() => void entries.loadMore()}
            >
              Load more
            </Button>
          </Group>
        )}
      </Section>
      <ResourceDrawer
        opened={edit.opened}
        onClose={edit.close}
        title="Edit collection"
        submitLabel="Save"
        onSubmit={save}
        busy={act.busy}
        disabled={
          !edit.form.name.trim() ||
          !capOk(edit.form.maxEntries, KV_MAX_ENTRIES_HARD) ||
          !capOk(edit.form.maxEntriesPerOwner, KV_MAX_ENTRIES_PER_OWNER_HARD)
        }
        error={edit.opened ? act.error : null}
        danger={{
          label: "Delete collection",
          description:
            "Every entry goes with it; large collections drain in the background.",
          onConfirm: remove,
          disabled: act.busy,
        }}
      >
        <div>
          <CopyField label="Collection id" value={col.id} />
          <Group gap="xs" my={4}>
            <ScopeBadges col={col} />
          </Group>
          <Text size="xs" c="dimmed">
            {KV_IMMUTABLE_NOTE}
          </Text>
        </div>
        <NameDescriptionFields
          name={edit.form.name}
          description={edit.form.description}
          onName={(name) => edit.patch({ name })}
          onDescription={(description) => edit.patch({ description })}
        />
        <CapFields
          maxEntries={edit.form.maxEntries}
          maxEntriesPerOwner={edit.form.maxEntriesPerOwner}
          userNamespace={userNs}
          onChange={(p) => edit.patch(p)}
        />
      </ResourceDrawer>
      <ResourceDrawer
        opened={entryForm.opened}
        onClose={entryForm.close}
        title={f.mode === "edit" ? "Edit entry" : "New entry"}
        submitLabel={f.mode === "edit" ? "Save" : "Put entry"}
        onSubmit={submitEntry}
        busy={entryAct.busy}
        disabled={!!(keyProblem || ownerProblem || valueProblem)}
        error={entryForm.opened ? entryAct.error : null}
        size="lg"
      >
        {userNs && (
          <TextInput
            label="Owner"
            description="The player's user id as the auth channel derives it."
            value={f.owner}
            onChange={(e) => entryForm.patch({ owner: e.currentTarget.value })}
            required
            disabled={f.mode === "edit"}
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            data-autofocus={f.mode === "create" && f.owner === ""}
          />
        )}
        <TextInput
          label="Key"
          description="1–128 of A–Z a–z 0–9 . _ : - starting with a letter or digit."
          value={f.key}
          onChange={(e) => entryForm.patch({ key: e.currentTarget.value })}
          required
          disabled={f.mode === "edit"}
          maxLength={128}
          autoComplete="off"
          spellCheck={false}
          data-autofocus={f.mode === "create" && (!userNs || f.owner !== "")}
        />
        <Textarea
          label="Value (JSON)"
          description="Stored byte for byte as typed, at most 16 KiB."
          value={f.valueText}
          onChange={(e) =>
            entryForm.patch({ valueText: e.currentTarget.value })
          }
          required
          autosize
          minRows={4}
          maxRows={16}
          styles={{
            input: { fontFamily: "var(--mantine-font-family-monospace)" },
          }}
          error={f.valueText !== "" ? valueProblem : undefined}
          data-autofocus={f.mode === "edit"}
        />
        <NumberInput
          label="TTL (seconds)"
          description={
            f.mode === "edit"
              ? "Empty keeps the current expiry; 0 clears it."
              : "Empty means the entry never expires."
          }
          value={f.ttl}
          onChange={(v) => entryForm.patch({ ttl: v })}
          min={0}
          max={366 * 24 * 60 * 60}
          allowDecimal={false}
          allowNegative={false}
        />
        {f.mode === "edit" && (
          <Text size="xs" c="dimmed">
            Saves only if the entry is still at version {f.version}; a change
            made meanwhile is answered with a conflict.
          </Text>
        )}
      </ResourceDrawer>
    </>
  );
}

/** `NumberInput` hands back `""` while a field is being retyped. */
export type CapValue = number | string;
export const capOk = (v: CapValue, hard: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= hard;

/** The two caps, shared by the create drawer (Project tab) and the edit drawer. */
export function CapFields({
  maxEntries,
  maxEntriesPerOwner,
  userNamespace,
  onChange,
}: {
  maxEntries: CapValue;
  maxEntriesPerOwner: CapValue;
  userNamespace: boolean;
  onChange: (p: {
    maxEntries?: CapValue;
    maxEntriesPerOwner?: CapValue;
  }) => void;
}) {
  return (
    <>
      <NumberInput
        label="Max entries"
        description={`1–${KV_MAX_ENTRIES_HARD}, counted on create; expired rows are purged first.`}
        value={maxEntries}
        onChange={(v) => onChange({ maxEntries: v })}
        min={1}
        max={KV_MAX_ENTRIES_HARD}
        clampBehavior="none"
        allowDecimal={false}
        allowNegative={false}
        required
      />
      <NumberInput
        label="Max entries per owner"
        description={
          userNamespace
            ? `1–${KV_MAX_ENTRIES_PER_OWNER_HARD}; bounds a player writing its own namespace.`
            : `1–${KV_MAX_ENTRIES_PER_OWNER_HARD}; only applies when the write scope is user.`
        }
        value={maxEntriesPerOwner}
        onChange={(v) => onChange({ maxEntriesPerOwner: v })}
        min={1}
        max={KV_MAX_ENTRIES_PER_OWNER_HARD}
        clampBehavior="none"
        allowDecimal={false}
        allowNegative={false}
        required
      />
    </>
  );
}
