import {
  Anchor,
  Button,
  Card,
  Checkbox,
  Code,
  Group,
  Select,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { Badge, Notice, Spinner } from "../components/ui";
import { fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";

/** Latest installer builds; every member may install them. */
function InstallerDownloads() {
  const list = useApiQuery(["catalog", "installer"], () =>
    api.installerDownloads(),
  );
  if (!list.data?.length) return null;
  return (
    <Card withBorder mb="md" padding="sm">
      <Text size="sm" fw={600} mb={4}>
        Installer
      </Text>
      <Group gap="sm">
        {list.data.map((d) => (
          <Anchor key={d.url} href={d.url} size="sm">
            {d.filename}
            {d.version ? ` (v${d.version})` : ""}
          </Anchor>
        ))}
      </Group>
    </Card>
  );
}

export function CatalogPage() {
  const apps = useApiQuery(["catalog", "apps"], () => api.catalogApps());
  const groups = useApiQuery(["catalog", "groups"], () => api.catalogGroups());
  const act = useAction();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [groupId, setGroupId] = useState<string | null>(null);
  const [debugOnly, setDebugOnly] = useState(false);
  const [groupName, setGroupName] = useState("");

  const groupNameOf = (id: string | null) =>
    (id && groups.data?.find((g) => g.id === id)?.name) || "—";

  const createApp = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() =>
      api.createCatalogApp({
        name: name.trim(),
        path: path.trim(),
        debugOnly,
        ...(groupId ? { groupId } : {}),
      }),
    );
    if (!r) return;
    setName("");
    setPath("");
    setDebugOnly(false);
    await apps.reload();
  };

  const createGroup = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() => api.createCatalogGroup(groupName.trim()));
    if (!r) return;
    setGroupName("");
    await groups.reload();
  };

  return (
    <>
      <Title order={2} mb="sm">
        Catalog
      </Title>
      <Text size="sm" c="dimmed" mb="sm">
        Binary distribution: apps hold build artifacts served from the public
        CDN. You see the apps you own or were granted access to.
      </Text>
      <InstallerDownloads />
      {act.error && <Notice kind="error">{act.error}</Notice>}

      <Card withBorder mb="md" padding="sm">
        <form onSubmit={(e) => void createApp(e)}>
          <Group align="end" wrap="wrap">
            <TextInput
              label="New app"
              placeholder="name (e.g. my-game)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={64}
            />
            <TextInput
              label="Application id"
              placeholder="life.yyt.my-game"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              required
              maxLength={200}
            />
            <Select
              label="Group"
              placeholder="(none)"
              clearable
              data={(groups.data ?? []).map((g) => ({
                value: g.id,
                label: g.name,
              }))}
              value={groupId}
              onChange={setGroupId}
            />
            <Checkbox
              label="Debug only"
              checked={debugOnly}
              onChange={(e) => setDebugOnly(e.currentTarget.checked)}
              mb={8}
            />
            <Button
              type="submit"
              disabled={act.busy || !name.trim() || !path.trim()}
            >
              Create app
            </Button>
          </Group>
        </form>
      </Card>

      {apps.error && <Notice kind="error">{apps.error}</Notice>}
      {apps.loading && !apps.data ? (
        <Spinner />
      ) : apps.data?.length ? (
        <Table.ScrollContainer minWidth={640}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>App</Table.Th>
                <Table.Th>Application id</Table.Th>
                <Table.Th>Group</Table.Th>
                <Table.Th>Owner</Table.Th>
                <Table.Th>Updated</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {apps.data.map((a) => (
                <Table.Tr key={a.id}>
                  <Table.Td>
                    <Anchor
                      component={Link}
                      to={`/catalog/apps/${encodeURIComponent(a.name)}`}
                      size="sm"
                    >
                      {a.name}
                    </Anchor>{" "}
                    {a.debugOnly && <Badge tone="warn">debug</Badge>}
                  </Table.Td>
                  <Table.Td>
                    <Code>{a.path}</Code>
                  </Table.Td>
                  <Table.Td>{groupNameOf(a.groupId)}</Table.Td>
                  <Table.Td>
                    {a.ownerLogin ?? a.pendingOwnerLogin ?? "—"}
                    {a.pendingOwnerLogin && <Badge tone="warn">pending</Badge>}
                  </Table.Td>
                  <Table.Td>{fmtTime(a.updatedAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <Text size="sm" c="dimmed">
          No apps visible to you yet.
        </Text>
      )}

      <Title order={4} mt="lg" mb="xs">
        Groups
      </Title>
      <Card withBorder mb="md" padding="sm">
        <form onSubmit={(e) => void createGroup(e)}>
          <Group align="end">
            <TextInput
              label="New group"
              placeholder="name (e.g. team-a)"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              required
              maxLength={64}
            />
            <Button type="submit" disabled={act.busy || !groupName.trim()}>
              Create group
            </Button>
          </Group>
        </form>
      </Card>
      {groups.error && <Notice kind="error">{groups.error}</Notice>}
      {groups.loading && !groups.data ? (
        <Spinner />
      ) : groups.data?.length ? (
        <Table.ScrollContainer minWidth={480}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Group</Table.Th>
                <Table.Th>Owner</Table.Th>
                <Table.Th>Created</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {groups.data.map((g) => (
                <Table.Tr key={g.id}>
                  <Table.Td>
                    <Anchor
                      component={Link}
                      to={`/catalog/groups/${encodeURIComponent(g.id)}`}
                      size="sm"
                    >
                      {g.name}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>
                    {g.ownerLogin ?? g.pendingOwnerLogin ?? "—"}
                    {g.pendingOwnerLogin && <Badge tone="warn">pending</Badge>}
                  </Table.Td>
                  <Table.Td>{fmtTime(g.createdAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <Text size="sm" c="dimmed">
          No groups visible to you.
        </Text>
      )}
    </>
  );
}
