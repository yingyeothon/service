import { Button, Code, Group, Table, Text, TextInput } from "@mantine/core";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { DataTable } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { RowMenu, type RowMenuItem } from "../components/RowMenu";
import { Section } from "../components/Section";
import { Badge, Notice } from "../components/ui";
import { useConfirm } from "../lib/confirm";
import { fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { useListQuery } from "../lib/listQuery";
import { useAction, useApiQuery } from "../lib/query";
import { teamUrl } from "../lib/team";
import type { Member, Role, SiteNameRecord } from "../types";

/**
 * Which catalog app `GET /catalog/installer/downloads` serves. Its team must
 * be admin-locked, or every member of that team could push the APK every
 * device self-updates to.
 */
export function InstallerAppSection() {
  const setting = useApiQuery(["admin", "installer-app"], () =>
    api.installerApp(),
  );
  const act = useAction();
  const confirm = useConfirm();
  const [appId, setAppId] = useState("");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() => api.setInstallerApp(appId.trim() || null));
    if (!r) return;
    setting.set(r);
    setAppId("");
    notify.saved("installer app");
  };
  const clear = async () => {
    const ok = await confirm({
      title: "Clear the installer app?",
      message: "The downloads route answers 503 until another app is set.",
      confirmLabel: "Clear installer app",
      danger: true,
    });
    if (!ok.ok) return;
    const r = await act.run(() => api.setInstallerApp(null));
    if (r) {
      setting.set(r);
      notify.done("Installer app cleared");
    }
  };
  const s = setting.data;
  return (
    <Section
      title="Installer app"
      description="The catalog app whose builds the device installer downloads. Its team must be admin-locked."
    >
      {setting.error && <Notice kind="error">{setting.error}</Notice>}
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {s && (
        <Text size="sm" mb="sm">
          {s.appId ? (
            <>
              <strong>{s.appName ?? s.appId}</strong> (<code>{s.appId}</code>)
              in{" "}
              {s.teamId ? (
                <Link to={teamUrl(s.teamId)}>{s.teamName ?? s.teamId}</Link>
              ) : (
                "no team"
              )}{" "}
              ·{" "}
              {s.trusted ? (
                <Badge tone="ok">trusted</Badge>
              ) : (
                <Badge tone="danger">untrusted — downloads answer 503</Badge>
              )}
            </>
          ) : (
            "Not set: the downloads route answers 503."
          )}
        </Text>
      )}
      <form onSubmit={(e) => void save(e)}>
        <Group align="end" wrap="wrap">
          <TextInput
            label="Catalog app id"
            placeholder="ca_…"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
          />
          <Button
            type="submit"
            variant="default"
            disabled={act.busy || !appId.trim()}
          >
            Save
          </Button>
          {s?.appId && (
            <Button
              variant="default"
              disabled={act.busy}
              onClick={() => void clear()}
            >
              Clear
            </Button>
          )}
        </Group>
      </form>
    </Section>
  );
}

/**
 * A site name that has served files stays with its team for good
 * (docs/decisions.md *Site domains* §5); a platform admin's release, with a
 * reason for the audit log, is the one way it becomes claimable again.
 */
export function SiteNameSection() {
  const act = useAction();
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const [row, setRow] = useState<SiteNameRecord | null>(null);
  const lookUp = async (e: FormEvent) => {
    e.preventDefault();
    setRow(null);
    const r = await act.run(() => api.siteName(name.trim().toLowerCase()));
    if (r) setRow(r);
  };
  const release = async (r: SiteNameRecord) => {
    const c = await confirm({
      title: `Release ${r.name}?`,
      message:
        "Its files are deleted and any team may claim the name. Browser state on its origin (storage, service workers) outlives the release.",
      confirmLabel: `Release ${r.name}`,
      danger: true,
      reason: { required: true, maxLength: 500 },
    });
    if (!c.ok || !c.reason) return;
    const reason = c.reason;
    const ok = await act.run(async () => {
      await api.releaseSiteName(r.name, reason);
      return true;
    });
    if (!ok) return;
    notify.done(`Released ${r.name}`);
    setRow(null);
    setName("");
  };
  const inUse = row !== null && row.releasedAt === null;
  return (
    <Section
      title="Site names"
      description="Who keeps a site name. Releasing one deletes what is left under it and frees it for every team; refused while a site uses it."
    >
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <form onSubmit={(e) => void lookUp(e)}>
        <Group align="end" wrap="wrap">
          <TextInput
            label="Site name"
            placeholder="my-game"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            maxLength={32}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
          <Button
            type="submit"
            variant="default"
            disabled={act.busy || !name.trim()}
          >
            Look up
          </Button>
        </Group>
      </form>
      {row && (
        <Group mt="sm" gap="md" wrap="wrap" align="center">
          <Text size="sm" component="div">
            <Code>{row.name}</Code> · {row.kind} ·{" "}
            {row.teamId ? (
              <Link to={teamUrl(row.teamId)}>{row.teamId}</Link>
            ) : (
              "no team"
            )}{" "}
            · recorded {fmtTime(row.createdAt)}
            {row.createdBy ? ` by ${row.createdBy}` : ""} ·{" "}
            {inUse ? (
              <Badge tone="ok">in use</Badge>
            ) : (
              <>released {fmtTime(row.releasedAt)}</>
            )}
            {row.served ? " · served files" : ""}
            {row.purgedAt !== null ? ` · emptied ${fmtTime(row.purgedAt)}` : ""}
          </Text>
          <Button
            variant="default"
            disabled={act.busy || inUse}
            onClick={() => void release(row)}
          >
            Release name
          </Button>
        </Group>
      )}
    </Section>
  );
}

const TONE: Record<Role, string> = {
  admin: "accent",
  member: "ok",
  pending: "warn",
};

export function MembersPage() {
  const { me } = useAuth();
  const lq = useListQuery();
  const list = useApiQuery(
    ["members", lq.params],
    () => api.members(lq.params),
    { keepPrevious: true },
  );
  const act = useAction();
  const go = async (
    m: Member,
    action: "approve" | "promote" | "demote",
    done: string,
  ) => {
    if (await act.run(() => api.memberAction(m.id, action))) {
      notify.done(`${m.login} ${done}`);
      await list.reload();
    }
  };
  const pending = list.data?.filter((m) => m.role === "pending") ?? [];
  const items = (m: Member): RowMenuItem[] => {
    if (m.role === "member")
      return [
        {
          label: "Promote to admin",
          onClick: () => go(m, "promote", "promoted"),
          disabled: act.busy,
          confirm: {
            title: `Promote ${m.login} to admin?`,
            message:
              "Admins approve sign-ups, read every team and delete anything.",
            confirmLabel: "Promote to admin",
          },
        },
      ];
    if (m.role === "admin" && m.id !== me?.id)
      return [
        {
          label: "Demote to member",
          danger: true,
          onClick: () => go(m, "demote", "demoted"),
          disabled: act.busy,
          confirm: {
            title: `Demote ${m.login}?`,
            confirmLabel: "Demote to member",
            danger: true,
          },
        },
      ];
    return [];
  };
  return (
    <>
      <PageHeader
        title="Members"
        description="Everyone who signed in with GitHub. New sign-ups wait here until an admin approves them."
      />
      <InstallerAppSection />
      <SiteNameSection />
      <Section title="Platform members">
        {act.error && <Notice kind="error">{act.error}</Notice>}
        {pending.length > 0 && (
          <Notice kind="warn">
            {pending.length} sign-up{pending.length > 1 ? "s" : ""} waiting for
            approval.
          </Notice>
        )}
        <DataTable
          columns={[
            { key: "login", label: "Login", sortKey: "login" },
            { key: "role", label: "Role", sortKey: "role" },
            {
              key: "signed",
              label: "Signed up",
              sortKey: "createdAt",
              defaultOrder: "desc",
            },
            {
              key: "approved",
              label: "Approved",
              sortKey: "approvedAt",
              defaultOrder: "desc",
            },
          ]}
          rows={list.data}
          loading={list.loading}
          fetching={list.fetching}
          error={list.error}
          sort={lq.sort}
          onSort={lq.setSort}
          rowKey={(m) => m.id}
          minWidth={640}
          empty={{ title: "No members yet." }}
          render={(m) => (
            <>
              <Table.Td>
                {m.login}
                {m.id === me?.id && (
                  <Text span size="sm" c="dimmed">
                    {" "}
                    (you)
                  </Text>
                )}
              </Table.Td>
              <Table.Td>
                <Badge tone={TONE[m.role]}>{m.role}</Badge>
                {m.role === "pending" && (
                  <Button
                    ml="sm"
                    size="compact-sm"
                    variant="default"
                    disabled={act.busy}
                    onClick={() => void go(m, "approve", "approved")}
                  >
                    Approve
                  </Button>
                )}
              </Table.Td>
              <Table.Td>{fmtTime(m.createdAt)}</Table.Td>
              <Table.Td>{fmtTime(m.approvedAt)}</Table.Td>
            </>
          )}
          actions={(m) => <RowMenu name={m.login} items={items(m)} />}
        />
      </Section>
    </>
  );
}
