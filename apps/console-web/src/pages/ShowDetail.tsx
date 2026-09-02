import { Anchor, Button, Table, Text, TextInput } from "@mantine/core";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { hasRole, useAuth } from "../auth";
import { Crumbs } from "../components/Crumbs";
import { DataTable } from "../components/DataTable";
import { EntryGrid } from "../components/EntryGrid";
import { PageSkeleton } from "../components/Loading";
import { Markdown } from "../components/Markdown";
import { MdField } from "../components/MdField";
import { PageHeader, type HeaderAction } from "../components/PageHeader";
import { ResourceDrawer, useDrawerForm } from "../components/ResourceDrawer";
import { RowMenu } from "../components/RowMenu";
import { Section } from "../components/Section";
import { TargetPicker, targetValue } from "../components/TargetPicker";
import { Badge, Notice } from "../components/ui";
import { useConfirm } from "../lib/confirm";
import { fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { useAction, useApiQuery } from "../lib/query";
import type { ShowAcl, ShowEntry, ShowTargetKind } from "../types";
import { AclField } from "./Shows";

const SHOWS_CRUMB = [{ label: "Shows", to: "/shows" }];

export function ShowDetailPage() {
  const { id = "" } = useParams();
  const { me } = useAuth();
  const nav = useNavigate();
  const act = useAction();
  const confirm = useConfirm();
  const [sort, setSort] = useState<"new" | "likes">("new");
  const show = useApiQuery(["show", id, me?.id ?? null], () => api.show(id));
  // Cursor paging: the wall holds up to 200 entries and a page is 24, so
  // without this three quarters of a full show is unreachable.
  const [more, setMore] = useState<ShowEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const entries = useApiQuery(["show-entries", id, sort, me?.id ?? null], () =>
    api.showEntries(id, { sort }),
  );
  useEffect(() => {
    setMore([]);
    setNext(entries.data?.next ?? null);
  }, [entries.data]);
  const loadMore = async () => {
    if (!next) return;
    const page = await act.run(() =>
      api.showEntries(id, { sort, cursor: next }),
    );
    if (!page) return;
    setMore((prev) => [...prev, ...page.entries]);
    setNext(page.next);
  };
  const s = show.data;
  const canManage = s?.canManage ?? false;
  /**
   * An admin acting on a show that is not theirs must say why, on every
   * mutating call — not only the destructive ones (decision 12).
   */
  const foreign =
    canManage && s !== undefined && s.createdBy !== (me?.login ?? null);

  const submit = useDrawerForm(() => ({
    target: null as string | null,
    title: "",
    bodyMd: "",
  }));
  const submittable = useApiQuery(
    ["show-submittable", id],
    () => api.showSubmittable(id),
    { enabled: submit.opened },
  );
  const edit = useDrawerForm<{ bodyMd: string; acl: ShowAcl; reason: string }>(
    () => ({ bodyMd: s?.bodyMd ?? "", acl: s?.acl ?? "public", reason: "" }),
  );
  const grant = useDrawerForm(() => ({ login: "" }));

  const reload = async () => {
    await Promise.all([show.reload(), entries.reload()]);
  };

  const submitEntry = async (e: FormEvent) => {
    e.preventDefault();
    const f = submit.form;
    if (!f.target || !f.title.trim()) return;
    const [kind, ...rest] = f.target.split(":");
    const r = await act.run(() =>
      api.submitEntry(id, {
        targetKind: kind as ShowTargetKind,
        targetId: rest.join(":"),
        title: f.title.trim(),
        bodyMd: f.bodyMd || undefined,
      }),
    );
    if (!r) return;
    submit.close();
    notify.done("Entry put up");
    await reload();
  };
  const savePage = async (e: FormEvent) => {
    e.preventDefault();
    if (!s) return;
    const f = edit.form;
    const body: { bodyMd?: string; acl?: ShowAcl; reason?: string } = {};
    if (f.bodyMd !== s.bodyMd) body.bodyMd = f.bodyMd;
    if (f.acl !== s.acl) body.acl = f.acl;
    if (Object.keys(body).length === 0) {
      edit.close();
      return;
    }
    if (foreign) body.reason = f.reason.trim();
    const r = await act.run(() => api.updateShow(id, body));
    if (!r) return;
    edit.close();
    notify.saved("show");
    await show.reload();
  };
  const grantAccess = async (e: FormEvent) => {
    e.preventDefault();
    const login = grant.form.login.trim();
    const r = await act.run(() => api.grantShow(id, login).then(() => true));
    if (!r) return;
    grant.close();
    notify.done(`${login} may put work up`);
    await show.reload();
  };
  const revoke = async (login: string) => {
    if (await act.run(() => api.revokeShow(id, login).then(() => true))) {
      notify.done(`${login} revoked`);
      await show.reload();
    }
  };
  const toggleClosed = async () => {
    if (!s) return;
    const closed = s.closedAt !== null;
    const r = await confirm({
      title: closed ? "Reopen the show?" : "Close the show?",
      message: closed
        ? "Reopening changes nothing about who may see it."
        : "A closed show is read-only; it can be reopened.",
      confirmLabel: closed ? "Reopen show" : "Close show",
      reason: foreign ? { required: true } : undefined,
    });
    if (!r.ok) return;
    const ok = await act.run(() =>
      (closed
        ? api.reopenShow(id, r.reason)
        : api.closeShow(id, r.reason)
      ).then(() => true),
    );
    if (ok) {
      notify.done(closed ? "Show reopened" : "Show closed");
      await reload();
    }
  };
  const remove = async () => {
    const r = await confirm({
      title: "Delete the show?",
      message: "Every entry on the wall goes with it.",
      confirmLabel: "Delete show",
      danger: true,
      reason: { required: true, placeholder: "Why is this being removed?" },
    });
    if (!r.ok || !r.reason) return;
    if (await act.run(() => api.deleteShow(id, r.reason!).then(() => true))) {
      notify.deleted("show");
      void nav("/shows");
    }
  };

  if (show.error)
    return (
      <>
        <Crumbs trail={SHOWS_CRUMB} />
        <PageHeader />
        <Notice kind="error">{show.error}</Notice>
      </>
    );
  if (!s)
    return (
      <>
        <Crumbs trail={SHOWS_CRUMB} />
        <PageHeader />
        <PageSkeleton />
      </>
    );

  const closed = s.closedAt !== null;
  const actions: HeaderAction[] = [];
  if (s.canWrite && !closed)
    actions.push({
      label: "Put something up",
      primary: true,
      onClick: submit.open,
    });
  if (canManage) {
    actions.push({ label: "Edit", onClick: edit.open });
    actions.push({
      label: closed ? "Reopen show" : "Close show",
      menu: true,
      onClick: toggleClosed,
      disabled: act.busy,
    });
  }
  if (hasRole(me, "admin"))
    actions.push({
      label: "Delete show",
      danger: true,
      onClick: remove,
      disabled: act.busy,
    });

  return (
    <>
      <Crumbs trail={SHOWS_CRUMB} current={s.title} />
      <PageHeader
        title={s.title}
        badges={
          <>
            <Badge tone={s.acl === "public" ? "ok" : "neutral"}>
              {s.acl === "public" ? "everyone may see this" : "members only"}
            </Badge>
            {closed && <Badge tone="neutral">closed</Badge>}
          </>
        }
        meta={
          <>
            {s.createdBy ?? "—"} · {fmtTime(s.createdAt)} · {s.entryCount}{" "}
            {s.entryCount === 1 ? "entry" : "entries"}
            {s.eventId && (
              <>
                {" · "}
                <Anchor component={Link} to={`/events/${s.eventId}`} size="sm">
                  From the event page
                </Anchor>
              </>
            )}
          </>
        }
        actions={actions}
      />
      {act.error && !submit.opened && !edit.opened && !grant.opened && (
        <Notice kind="error">{act.error}</Notice>
      )}
      {closed && (
        <Notice kind="info">
          This show is closed: it is read-only, and reopening it changes nothing
          about who may see it.
        </Notice>
      )}
      {s.bodyMd && <Markdown text={s.bodyMd} />}

      {canManage && (
        <Section
          title="Who may put work up"
          description="Only you and platform admins may submit unless you grant someone."
          actions={
            <Button variant="default" onClick={grant.open}>
              Grant access
            </Button>
          }
        >
          <DataTable
            columns={[
              { key: "login", label: "Login" },
              { key: "by", label: "Granted by" },
              { key: "at", label: "Since" },
            ]}
            rows={s.grants ?? []}
            rowKey={(g) => g.login ?? String(g.grantedAt)}
            minWidth={420}
            empty={{ title: "Only you (and platform admins) may submit." }}
            render={(g) => (
              <>
                <Table.Td>{g.login ?? "—"}</Table.Td>
                <Table.Td>{g.grantedBy ?? "—"}</Table.Td>
                <Table.Td>{fmtTime(g.grantedAt)}</Table.Td>
              </>
            )}
            actions={(g) =>
              g.login ? (
                <RowMenu
                  name={g.login}
                  items={[
                    {
                      label: "Revoke",
                      danger: true,
                      disabled: act.busy,
                      onClick: () => revoke(g.login!),
                      confirm: {
                        title: `Revoke ${g.login}?`,
                        message: "What they already put up stays.",
                        confirmLabel: "Revoke",
                        danger: true,
                      },
                    },
                  ]}
                />
              ) : null
            }
          />
        </Section>
      )}

      <Section title="On the wall">
        {entries.error && <Notice kind="error">{entries.error}</Notice>}
        <EntryGrid
          entries={[...(entries.data?.entries ?? []), ...more]}
          sort={sort}
          onSort={setSort}
          loading={entries.loading && !entries.data}
          onMore={next ? () => void loadMore() : undefined}
        />
      </Section>

      <ResourceDrawer
        opened={submit.opened}
        onClose={submit.close}
        title="Put something up"
        submitLabel="Submit entry"
        onSubmit={submitEntry}
        busy={act.busy}
        disabled={!submit.form.target || !submit.form.title.trim()}
        error={submit.opened ? (submittable.error ?? act.error) : null}
        size="lg"
      >
        <TargetPicker
          targets={submittable.data ?? []}
          value={submit.form.target}
          disabled={act.busy}
          onChange={(v) => {
            const picked = (submittable.data ?? []).find(
              (t) => targetValue(t.kind, t.id) === v,
            );
            submit.patch({
              target: v,
              ...(picked && !submit.form.title ? { title: picked.name } : {}),
            });
          }}
        />
        <TextInput
          label="Title"
          value={submit.form.title}
          onChange={(e) => submit.patch({ title: e.currentTarget.value })}
          required
          maxLength={200}
          autoComplete="off"
        />
        <MdField
          label="About it"
          value={submit.form.bodyMd}
          onChange={(bodyMd) => submit.patch({ bodyMd })}
        />
        <Text size="xs" c="dimmed">
          Submitting is publication: the name and the link of what you pick
          become visible to everyone who can see this show.
        </Text>
      </ResourceDrawer>

      <ResourceDrawer
        opened={edit.opened}
        onClose={edit.close}
        title="Edit show"
        submitLabel="Save"
        onSubmit={savePage}
        busy={act.busy}
        disabled={foreign && !edit.form.reason.trim()}
        error={edit.opened ? act.error : null}
        size="lg"
      >
        <MdField
          label="Page"
          value={edit.form.bodyMd}
          onChange={(bodyMd) => edit.patch({ bodyMd })}
          minRows={6}
        />
        <AclField
          value={edit.form.acl}
          onChange={(acl) => edit.patch({ acl })}
          description="Opening a show to everyone is refused once it has entries: people submitted to the audience they were shown."
        />
        {foreign && (
          <TextInput
            label="Why are you acting on somebody else's show?"
            description="Recorded with the action in the audit log."
            value={edit.form.reason}
            onChange={(e) => edit.patch({ reason: e.currentTarget.value })}
            required
          />
        )}
      </ResourceDrawer>

      <ResourceDrawer
        opened={grant.opened}
        onClose={grant.close}
        title="Grant write access"
        submitLabel="Grant access"
        onSubmit={grantAccess}
        busy={act.busy}
        disabled={!grant.form.login.trim()}
        error={grant.opened ? act.error : null}
      >
        <TextInput
          label="GitHub login"
          value={grant.form.login}
          onChange={(e) => grant.patch({ login: e.currentTarget.value })}
          required
          autoComplete="off"
          spellCheck={false}
          data-autofocus
        />
      </ResourceDrawer>
    </>
  );
}
