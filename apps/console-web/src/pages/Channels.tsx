import {
  Anchor,
  Button,
  Code,
  Group,
  NativeSelect,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { Badge, Notice, Spinner } from "../components/ui";
import { fmtRelative, fmtTime } from "../lib/format";
import { useApiQuery } from "../lib/query";
import type { ChannelKind, ChannelStatus } from "../types";

const STATUS_TONE: Record<ChannelStatus, string> = {
  active: "ok",
  expired: "warn",
  disabled: "danger",
};

export function ChannelsPage() {
  const { me } = useAuth();
  const [kind, setKind] = useState<ChannelKind | "">("");
  const [all, setAll] = useState(false);
  const list = useApiQuery(["channels", kind, all], () =>
    api.channels({ kind: kind || undefined, scope: all ? "all" : undefined }),
  );
  return (
    <>
      <Group justify="space-between" mb="sm">
        <Title order={2}>Channels</Title>
        <Button component={Link} to="/channels/new">
          New channel
        </Button>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        Channels expire 7 days after creation; extend them from the detail page
        (up to 28 days ahead). Expired channels are disabled, then deleted 30
        days later.
      </Text>
      <Group mb="md">
        <NativeSelect
          label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as ChannelKind | "")}
          data={[
            { value: "", label: "all" },
            { value: "auth", label: "auth" },
            { value: "topic", label: "topic" },
            { value: "match", label: "match" },
            { value: "lobby", label: "lobby" },
            { value: "q", label: "q" },
          ]}
        />
        {me?.role === "admin" && (
          <NativeSelect
            label="Scope"
            value={all ? "all" : "mine"}
            onChange={(e) => setAll(e.target.value === "all")}
            data={[
              { value: "mine", label: "mine" },
              { value: "all", label: "everyone (admin)" },
            ]}
          />
        )}
      </Group>
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <Table.ScrollContainer minWidth={560}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Kind</Table.Th>
                <Table.Th>Id</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Expires</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.data.map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td>
                    <Anchor
                      component={Link}
                      to={`/channels/${encodeURIComponent(c.id)}`}
                    >
                      {c.name}
                    </Anchor>
                    {all && c.ownerId !== me?.id && (
                      <Text span size="sm" c="dimmed">
                        {" "}
                        · {c.ownerId}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>{c.kind}</Table.Td>
                  <Table.Td>
                    <Code>{c.id}</Code>
                  </Table.Td>
                  <Table.Td>
                    <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
                  </Table.Td>
                  <Table.Td title={fmtTime(c.expiresAt)}>
                    {fmtRelative(c.expiresAt)}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <Text size="sm" c="dimmed">
          No channels yet.
        </Text>
      )}
    </>
  );
}
