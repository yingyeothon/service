import { Code, Table, TextInput } from "@mantine/core";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { DataTable } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { ResourceDrawer, useDrawerForm } from "../components/ResourceDrawer";
import { RowMenu } from "../components/RowMenu";
import { Notice, SecretOnce } from "../components/ui";
import { fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { useListQuery } from "../lib/listQuery";
import { useAction, useApiQuery } from "../lib/query";

export function TokensPage() {
  const lq = useListQuery();
  const list = useApiQuery(["tokens", lq.params], () => api.tokens(lq.params), {
    keepPrevious: true,
  });
  const act = useAction();
  const create = useDrawerForm(() => ({ name: "" }));
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(
    null,
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() => api.createToken(create.form.name.trim()));
    if (!r) return;
    create.close();
    setFresh({ name: r.name, token: r.token });
    notify.created("token");
    await list.reload();
  };
  const revoke = async (id: string) => {
    if (await act.run(() => api.revokeToken(id).then(() => true))) {
      notify.done("Token revoked");
      await list.reload();
    }
  };

  return (
    <>
      <PageHeader
        title="API tokens"
        description={
          <>
            Tokens authenticate the CLI:{" "}
            <Code>yyt login --api {window.location.origin} --token yyt_…</Code>.
            They carry your current role; revoke any you no longer use (max 20).
          </>
        }
        actions={[
          {
            label: "New token",
            primary: true,
            onClick: () => {
              act.clear();
              create.open();
            },
          },
        ]}
      />
      {act.error && !create.opened && <Notice kind="error">{act.error}</Notice>}
      {fresh && (
        <SecretOnce
          label={`Token "${fresh.name}"`}
          value={fresh.token}
          onDismiss={() => setFresh(null)}
        />
      )}
      <DataTable
        columns={[
          { key: "name", label: "Name", sortKey: "name" },
          { key: "id", label: "Id", sortKey: "id" },
          {
            key: "created",
            label: "Created",
            sortKey: "createdAt",
            defaultOrder: "desc",
          },
          {
            key: "used",
            label: "Last used",
            sortKey: "lastUsedAt",
            defaultOrder: "desc",
          },
        ]}
        rows={list.data}
        loading={list.loading}
        fetching={list.fetching}
        sort={lq.sort}
        onSort={lq.setSort}
        error={list.error}
        rowKey={(t) => t.id}
        empty={{
          title: "No tokens yet.",
          hint: "Create one to sign the CLI in.",
        }}
        render={(t) => (
          <>
            <Table.Td>{t.name}</Table.Td>
            <Table.Td>
              <Code>{t.id}</Code>
            </Table.Td>
            <Table.Td>{fmtTime(t.createdAt)}</Table.Td>
            <Table.Td>{fmtTime(t.lastUsedAt)}</Table.Td>
          </>
        )}
        actions={(t) => (
          <RowMenu
            name={t.name}
            items={[
              {
                label: "Revoke token",
                danger: true,
                disabled: act.busy,
                onClick: () => revoke(t.id),
                confirm: {
                  title: `Revoke "${t.name}"?`,
                  message: "Anything signed in with it is signed out.",
                  confirmLabel: "Revoke token",
                  danger: true,
                },
              },
            ]}
          />
        )}
      />
      <ResourceDrawer
        opened={create.opened}
        onClose={create.close}
        title="New token"
        submitLabel="Create token"
        onSubmit={submit}
        busy={act.busy}
        disabled={!create.form.name.trim()}
        error={create.opened ? act.error : null}
      >
        <TextInput
          label="Token name"
          description="Where it will live: a machine, a CI job."
          placeholder="laptop"
          value={create.form.name}
          onChange={(e) => create.patch({ name: e.currentTarget.value })}
          required
          maxLength={100}
          autoComplete="off"
          spellCheck={false}
          data-autofocus
        />
      </ResourceDrawer>
    </>
  );
}
