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
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError } from "../api";
import { CatalogPermissionsCard } from "../components/CatalogPermissions";
import { Badge, Confirm, Notice, Spinner } from "../components/ui";
import { fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";

export function CatalogGroupPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const group = useApiQuery(["catalog", "group", id], () =>
    api.catalogGroup(id),
  );
  const apps = useApiQuery(["catalog", "group", id, "apps"], () =>
    api.catalogGroupApps(id),
  );
  // `null` = not owner/admin: the card stays hidden (TanStack Query v5
  // rejects `undefined` from a queryFn).
  const perms = useApiQuery(["catalog", "group", id, "perms"], async () => {
    try {
      return await api.catalogGroupPermissions(id);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404))
        return null;
      throw e;
    }
  });
  const act = useAction();
  const [name, setName] = useState<string | null>(null);

  if (group.error) return <Notice kind="error">{group.error}</Notice>;
  if (!group.data) return <Spinner />;
  const g = group.data;

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    if (name === null || name.trim() === g.name) return setName(null);
    const r = await act.run(() =>
      api.updateCatalogGroup(g.id, { name: name.trim() }),
    );
    if (!r) return;
    setName(null);
    group.set(r);
  };

  return (
    <>
      <Title order={2} mb="sm">
        Group {g.name}
      </Title>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <Card withBorder mb="md" padding="sm">
        <Text size="sm" mb={4}>
          Owner: {g.ownerLogin ?? g.pendingOwnerLogin ?? "—"}{" "}
          {g.pendingOwnerLogin && <Badge tone="warn">pending</Badge>}
        </Text>
        <Text size="sm" c="dimmed" mb="sm">
          Created {fmtTime(g.createdAt)}
        </Text>
        <form onSubmit={(e) => void rename(e)}>
          <Group align="end">
            <TextInput
              label="Rename"
              value={name ?? g.name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
            />
            <Button
              type="submit"
              disabled={act.busy || name === null || !name.trim()}
            >
              Save
            </Button>
            <Confirm
              label="Delete group"
              onConfirm={async () => {
                const ok = await act.run(async () => {
                  await api.deleteCatalogGroup(g.id);
                  return true;
                });
                if (ok) void navigate("/catalog");
              }}
              disabled={act.busy}
            />
          </Group>
        </form>
        <Text size="xs" c="dimmed" mt={4}>
          Deleting a group detaches its apps; artifacts are untouched.
        </Text>
      </Card>

      {perms.error && <Notice kind="error">{perms.error}</Notice>}
      <CatalogPermissionsCard
        title="Group permissions (apply to every app in the group)"
        permissions={perms.data ?? undefined}
        onGrant={async (login, level) => {
          const r = await api.grantCatalogGroupPermission(g.id, login, level);
          perms.set(r);
          return r;
        }}
        onRevoke={async (pid) => {
          await api.revokeCatalogGroupPermission(g.id, pid);
          await perms.reload();
        }}
      />

      <Title order={4} mb="xs">
        Apps
      </Title>
      {apps.error && <Notice kind="error">{apps.error}</Notice>}
      {apps.loading && !apps.data ? (
        <Spinner />
      ) : apps.data?.length ? (
        <Table.ScrollContainer minWidth={480}>
          <Table>
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
                    </Anchor>
                  </Table.Td>
                  <Table.Td>{a.ownerLogin ?? "—"}</Table.Td>
                  <Table.Td>{fmtTime(a.updatedAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <Text size="sm" c="dimmed">
          No apps in this group.
        </Text>
      )}
    </>
  );
}
