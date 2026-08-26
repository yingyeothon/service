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
import { api } from "../api";
import { useAuth } from "../auth";
import { CopyField, Notice, Spinner } from "../components/ui";
import { InstallerDownloadCard } from "./Installer";

const CLI_INSTALL_CMD =
  "curl -fsSL https://raw.githubusercontent.com/yingyeothon/service/main/cli/install.sh | sh";

/** Home-page card with the one-line `yyt` CLI install command. */
export function CliInstallCard() {
  return (
    <Card withBorder padding="md" mb="md">
      <Group justify="space-between" align="center" wrap="wrap">
        <div>
          <Text fw={600}>yyt CLI</Text>
          <Text size="sm" c="dimmed">
            Installs the latest <Code>yyt</Code> release into your PATH, then
            sign in with{" "}
            <Anchor component={Link} to="/tokens">
              an API token
            </Anchor>
            . The phone app signs in from{" "}
            <Anchor component={Link} to="/app-login">
              App login
            </Anchor>
            .
          </Text>
        </div>
      </Group>
      <CopyField label="Install" value={CLI_INSTALL_CMD} />
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
      {me && me.role !== "pending" && <InstallerDownloadCard compact />}
      {me && me.role !== "pending" && <CliInstallCard />}
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
          <List.Item>
            <Anchor component={Link} to="/installer">
              Installer
            </Anchor>{" "}
            — every published build of the device installer.
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
    </>
  );
}
