import {
  Button,
  Card,
  Group,
  Select,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useState, type FormEvent } from "react";
import type { CatalogPermission, CatalogPermissionLevel } from "../types";
import { Badge, Confirm, Notice } from "./ui";
import { useAction } from "../lib/query";

/**
 * Owner/admin-only permission list shared by apps and groups. The parent
 * passes the API calls; a 403/404 from load simply hides the card (the API
 * decides who may manage permissions).
 */
export function CatalogPermissionsCard({
  title,
  permissions,
  onGrant,
  onRevoke,
}: {
  title: string;
  permissions: CatalogPermission[] | undefined;
  onGrant: (
    login: string,
    level: CatalogPermissionLevel,
  ) => Promise<CatalogPermission[] | undefined>;
  onRevoke: (pid: string) => Promise<void>;
}) {
  const act = useAction();
  const [login, setLogin] = useState("");
  const [level, setLevel] = useState<CatalogPermissionLevel>("read");
  if (permissions === undefined) return null;

  const grant = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() => onGrant(login.trim(), level));
    if (r) setLogin("");
  };

  return (
    <Card withBorder mb="md" padding="sm">
      <Text size="sm" fw={600} mb={4}>
        {title}
      </Text>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <form onSubmit={(e) => void grant(e)}>
        <Group align="end" mb="sm">
          <TextInput
            label="GitHub login"
            placeholder="octocat"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            required
            maxLength={100}
          />
          <Select
            label="Level"
            data={["read", "edit"]}
            value={level}
            onChange={(v) => setLevel((v as CatalogPermissionLevel) ?? "read")}
            allowDeselect={false}
            w={100}
          />
          <Button type="submit" disabled={act.busy || !login.trim()}>
            Grant
          </Button>
        </Group>
      </form>
      {permissions.length ? (
        <Table.ScrollContainer minWidth={480}>
          <Table>
            <Table.Tbody>
              {permissions.map((p) => (
                <Table.Tr key={p.id}>
                  <Table.Td>
                    {p.login ?? "?"}{" "}
                    {p.pending && <Badge tone="warn">pending</Badge>}
                  </Table.Td>
                  <Table.Td>
                    <Badge tone={p.level === "edit" ? "accent" : "neutral"}>
                      {p.level}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Confirm
                      label="Revoke"
                      onConfirm={() => void act.run(() => onRevoke(p.id))}
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
          No explicit permissions.
        </Text>
      )}
    </Card>
  );
}
