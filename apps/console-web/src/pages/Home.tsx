import {
  Anchor,
  Box,
  Button,
  Card,
  Code,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { Link } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { PageSkeleton } from "../components/Loading";
import { Section } from "../components/Section";
import { CopyField, Notice } from "../components/ui";
import { InstallerDownloadCard } from "./Installer";

const CLI_INSTALL_CMD =
  "curl -fsSL https://raw.githubusercontent.com/yingyeothon/service/main/cli/install.sh | sh";

/** The one-line `yyt` CLI install command. */
export function CliInstallCard() {
  return (
    <Card padding="md" mb="md">
      <Text fw={500}>yyt CLI</Text>
      <Text size="sm" c="dimmed" mb="xs">
        Installs the latest <Code>yyt</Code> release into your PATH, then sign
        in with{" "}
        <Anchor component={Link} to="/tokens">
          an API token
        </Anchor>
        . The phone app signs in from{" "}
        <Anchor component={Link} to="/app-login">
          App login
        </Anchor>
        .
      </Text>
      <CopyField label="Install" value={CLI_INSTALL_CMD} />
    </Card>
  );
}

/**
 * The console's one signature surface (DESIGN.md `signature-forest-card`):
 * a full-bleed forest card with the page title and a single white button.
 * The ink primary would vanish on it, so the button is secondary-on-dark.
 */
function Hero({ signedIn, pending }: { signedIn: boolean; pending: boolean }) {
  return (
    <Box
      component="header"
      p={{ base: "lg", sm: 48 }}
      mb="xl"
      style={{
        background: "var(--yyt-signature-forest)",
        color: "#ffffff",
        borderRadius: 12,
      }}
    >
      <Stack gap="md" maw={640}>
        <Title order={1} style={{ fontSize: 32, color: "inherit" }}>
          yyt console
        </Title>
        <Text size="md" style={{ color: "inherit", opacity: 0.9 }}>
          Operator console for the yyt.life contest services: teams and projects
          with their channels, app catalog, asset bundles and sites, API tokens
          for the <Code>yyt</Code> CLI, hackathon events and shows.
        </Text>
        <div>
          {!signedIn ? (
            <Button
              component="a"
              href={api.loginUrl("/")}
              variant="white"
              color="ink"
            >
              Sign in with GitHub
            </Button>
          ) : pending ? null : (
            <Button component={Link} to="/teams" variant="white" color="ink">
              Open your teams
            </Button>
          )}
        </div>
      </Stack>
    </Box>
  );
}

const PLACES: {
  to: string;
  label: string;
  text: string;
  admin?: boolean;
}[] = [
  {
    to: "/teams",
    label: "Teams",
    text: "Your teams and their projects: channels, catalog apps, asset bundles, sites, versions and issues.",
  },
  {
    to: "/channels",
    label: "Channels",
    text: "Every channel across your teams.",
  },
  {
    to: "/tokens",
    label: "API tokens",
    text: "For yyt login --token …",
  },
  {
    to: "/events",
    label: "Events",
    text: "Hackathon date votes, pages and comments.",
  },
  {
    to: "/shows",
    label: "Shows",
    text: "Walls where members put up what they built.",
  },
  {
    to: "/installer",
    label: "Installer",
    text: "Every published build of the device installer.",
  },
  {
    to: "/members",
    label: "Members",
    text: "Approve sign-ups.",
    admin: true,
  },
];

export function HomePage() {
  const { me, loading } = useAuth();
  if (loading) return <PageSkeleton />;
  const active = !!me && me.role !== "pending";
  return (
    <>
      <Hero signedIn={!!me} pending={me?.role === "pending"} />
      {!me && (
        <Text size="sm" c="dimmed">
          Published hackathon events are visible without signing in:{" "}
          <Anchor component={Link} to="/events">
            Events
          </Anchor>
          .
        </Text>
      )}
      {me?.role === "pending" && (
        <Notice kind="warn">
          Signed in as <strong>{me.login}</strong>. Your membership is{" "}
          <strong>pending</strong> — an admin has to approve it before you can
          join a team and create channels. Hackathon{" "}
          <Anchor component={Link} to="/events">
            events
          </Anchor>{" "}
          (date votes, comments) are open to you already.
        </Notice>
      )}
      {active && (
        <>
          <Section title="Get started">
            <InstallerDownloadCard compact />
            <CliInstallCard />
          </Section>
          <Section title="Where things are">
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
              {PLACES.filter((p) => !p.admin || me.role === "admin").map(
                (p) => (
                  <Card key={p.to} padding="md">
                    <Anchor component={Link} to={p.to} fw={500} size="lg">
                      {p.label}
                    </Anchor>
                    <Text size="sm" c="dimmed" mt={4}>
                      {p.text}
                    </Text>
                  </Card>
                ),
              )}
            </SimpleGrid>
          </Section>
        </>
      )}
    </>
  );
}
