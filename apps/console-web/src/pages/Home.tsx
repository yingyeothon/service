import {
  Anchor,
  Button,
  Card,
  Code,
  Group,
  List,
  Text,
  Title,
} from "@mantine/core";
import { Link } from "react-router";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { Notice, Spinner } from "../components/ui";
import { useApiQuery } from "../lib/query";

/** Latest installer builds; every member may install them. */
function InstallerDownloads() {
  const list = useApiQuery(["catalog", "installer"], async () => {
    try {
      return await api.installerDownloads();
    } catch (e) {
      // 503 `installer_untrusted`: no installer app is configured (or its team
      // is not admin-locked) — nothing to offer, not an error to paint.
      if (e instanceof ApiError && e.status === 503) return [];
      throw e;
    }
  });
  if (!list.data?.length) return null;
  return (
    <Card withBorder mt="md" padding="sm">
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

export function HomePage() {
  const { me, loading } = useAuth();
  if (loading) return <Spinner />;
  return (
    <>
      <Title order={2} mb="sm">
        yyt console
      </Title>
      {!me && (
        <Notice>
          <Text size="sm" mb="xs">
            Operator console for the yyt.life contest services: teams and
            projects with their channels, app catalog and asset bundles, API
            tokens for the <Code>yyt</Code> CLI, and hackathon events.
          </Text>
          <Button component="a" href={api.loginUrl("/")}>
            Sign in with GitHub
          </Button>
          <Text size="sm" c="dimmed" mt="xs">
            Published hackathon events are visible without signing in:{" "}
            <Anchor component={Link} to="/events">
              Events
            </Anchor>
            .
          </Text>
        </Notice>
      )}
      {me?.role === "pending" && (
        <Notice kind="warn">
          Signed in as <strong>{me.login}</strong>. Your membership is{" "}
          <strong>pending</strong> — an admin has to approve it before you can
          join a team and create channels. Hackathon{" "}
          <Anchor component={Link} to="/events">
            events
          </Anchor>{" "}
          (proposals, votes) are open to you already.
        </Notice>
      )}
      {me && me.role !== "pending" && (
        <List spacing="xs">
          <List.Item>
            <Anchor component={Link} to="/teams">
              Teams
            </Anchor>{" "}
            — your teams and their projects: channels, catalog apps, asset
            bundles, versions and issues.
          </List.Item>
          <List.Item>
            <Anchor component={Link} to="/channels">
              Channels
            </Anchor>{" "}
            — every channel across your teams.
          </List.Item>
          <List.Item>
            <Anchor component={Link} to="/tokens">
              API tokens
            </Anchor>{" "}
            — for <Code>yyt login --token …</Code>.
          </List.Item>
          <List.Item>
            <Anchor component={Link} to="/events">
              Events
            </Anchor>{" "}
            — hackathon proposals and votes.
          </List.Item>
          {me.role === "admin" && (
            <List.Item>
              <Anchor component={Link} to="/members">
                Members
              </Anchor>{" "}
              — approve sign-ups.
            </List.Item>
          )}
        </List>
      )}
      {me && me.role !== "pending" && <InstallerDownloads />}
    </>
  );
}
