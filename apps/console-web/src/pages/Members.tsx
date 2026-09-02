import { Button, Group, Table, Text, TextInput } from "@mantine/core";
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
import { useAction, useApiQuery } from "../lib/query";
import { teamUrl } from "../lib/team";
import type { Member, Role } from "../types";

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
      confirmLabel: "Clear",
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
              variant="outline"
              color="red"
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

const TONE: Record<Role, string> = {
  admin: "accent",
  member: "ok",
  pending: "warn",
};

export function MembersPage() {
  const { me } = useAuth();
  const list = useApiQuery(["members"], () => api.members());
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
            confirmLabel: "Promote",
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
            confirmLabel: "Demote",
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
            { key: "login", label: "Login" },
            { key: "role", label: "Role" },
            { key: "signed", label: "Signed up" },
            { key: "approved", label: "Approved" },
          ]}
          rows={list.data}
          loading={list.loading}
          error={list.error}
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
