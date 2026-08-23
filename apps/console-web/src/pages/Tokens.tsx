import {
  Button,
  Code,
  Group,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { Confirm, Notice, SecretOnce, Spinner } from "../components/ui";
import { fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";

export function TokensPage() {
  const list = useApiQuery(["tokens"], () => api.tokens());
  const act = useAction();
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(
    null,
  );

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() => api.createToken(name));
    if (!r) return;
    setFresh({ name: r.name, token: r.token });
    setName("");
    await list.reload();
  };
  const revoke = async (id: string) => {
    await act.run(() => api.revokeToken(id));
    await list.reload();
  };

  return (
    <>
      <Title order={2} mb="sm">
        API tokens
      </Title>
      <Text size="sm" c="dimmed" mb="sm">
        Tokens authenticate the CLI:{" "}
        <Code>yyt login --api {window.location.origin} --token yyt_…</Code>.
        They carry your current role; revoke any you no longer use (max 20).
      </Text>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {fresh && (
        <SecretOnce
          label={`Token "${fresh.name}"`}
          value={fresh.token}
          onDismiss={() => setFresh(null)}
        />
      )}
      <form onSubmit={(e) => void create(e)}>
        <Group align="end" mb="md">
          <TextInput
            aria-label="Token name"
            placeholder="name (e.g. laptop)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
          />
          <Button type="submit" disabled={act.busy || !name.trim()}>
            Create token
          </Button>
        </Group>
      </form>
      <Title order={4} mb="xs">
        Existing
      </Title>
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <Table.ScrollContainer minWidth={560}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Id</Table.Th>
                <Table.Th>Created</Table.Th>
                <Table.Th>Last used</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.data.map((t) => (
                <Table.Tr key={t.id}>
                  <Table.Td>{t.name}</Table.Td>
                  <Table.Td>
                    <Code>{t.id}</Code>
                  </Table.Td>
                  <Table.Td>{fmtTime(t.createdAt)}</Table.Td>
                  <Table.Td>{fmtTime(t.lastUsedAt)}</Table.Td>
                  <Table.Td>
                    <Confirm
                      label="Revoke"
                      onConfirm={() => revoke(t.id)}
                      disabled={act.busy}
                    />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <Text size="sm" c="dimmed">
          No tokens yet.
        </Text>
      )}
    </>
  );
}
