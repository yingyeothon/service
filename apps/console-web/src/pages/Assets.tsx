import {
  Anchor,
  Button,
  Card,
  Group,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { Notice, Spinner } from "../components/ui";
import { fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";

export function AssetsPage() {
  const bundles = useApiQuery(["assets", "bundles"], () => api.assetBundles());
  const act = useAction();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() =>
      api.createAssetBundle({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    );
    if (!r) return;
    setName("");
    setDescription("");
    await bundles.reload();
  };

  return (
    <>
      <Title order={2} mb="sm">
        Assets
      </Title>
      <Text size="sm" c="dimmed" mb="sm">
        Game content on the public CDN: maps with their NPC definitions inlined,
        tilesets, sounds. Every object is versioned, world-readable and cached
        forever — publishing a fix means uploading a new version and pointing a
        lobby channel&rsquo;s map URL at it.
      </Text>
      {act.error && <Notice kind="error">{act.error}</Notice>}

      <Card withBorder mb="md" padding="sm">
        <form onSubmit={(e) => void create(e)}>
          <Group align="end" wrap="wrap">
            <TextInput
              label="New bundle"
              placeholder="name (e.g. dungeon-maps)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={64}
            />
            <TextInput
              label="Description"
              placeholder="optional"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
            />
            <Button type="submit" disabled={act.busy || !name.trim()}>
              Create bundle
            </Button>
          </Group>
        </form>
      </Card>

      {bundles.error && <Notice kind="error">{bundles.error}</Notice>}
      {bundles.loading && !bundles.data ? (
        <Spinner />
      ) : bundles.data?.length ? (
        <Table.ScrollContainer minWidth={560}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Bundle</Table.Th>
                <Table.Th>Description</Table.Th>
                <Table.Th>Owner</Table.Th>
                <Table.Th>Updated</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {bundles.data.map((b) => (
                <Table.Tr key={b.id}>
                  <Table.Td>
                    <Anchor
                      component={Link}
                      to={`/assets/${encodeURIComponent(b.name)}`}
                      size="sm"
                    >
                      {b.name}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>{b.description ?? "—"}</Table.Td>
                  <Table.Td>{b.ownerLogin ?? "—"}</Table.Td>
                  <Table.Td>{fmtTime(b.updatedAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <Text size="sm" c="dimmed">
          No asset bundles yet.
        </Text>
      )}
    </>
  );
}
