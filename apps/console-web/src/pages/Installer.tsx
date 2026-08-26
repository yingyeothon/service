import {
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";
import { Link } from "react-router";
import { api, ApiError } from "../api";
import { Notice, Spinner } from "../components/ui";
import { fmtTime } from "../lib/format";
import { useApiQuery } from "../lib/query";
import type { InstallerDownload } from "../types";

export interface InstallerList {
  downloads: InstallerDownload[];
  /** Set when the route answered 503 `installer_untrusted`: nothing to offer. */
  untrusted: boolean;
}

const isUntrusted = (e: unknown): boolean =>
  e instanceof ApiError &&
  e.status === 503 &&
  typeof e.details === "object" &&
  e.details !== null &&
  (e.details as { reason?: unknown }).reason === "installer_untrusted";

/**
 * Latest installer builds, newest first. Only the `installer_untrusted` 503
 * (the installer app's team is not admin-locked) is folded into an empty
 * list; any other failure surfaces as an error.
 */
export function useInstallerDownloads() {
  return useApiQuery<InstallerList>(["catalog", "installer"], async () => {
    try {
      return { downloads: await api.installerDownloads(), untrusted: false };
    } catch (e) {
      if (isUntrusted(e)) return { downloads: [], untrusted: true };
      throw e;
    }
  });
}

/** The newest build (the route lists newest first). */
export const latestDownload = (
  list: InstallerList | undefined,
): InstallerDownload | undefined => list?.downloads[0];

const platformLabel = (p: InstallerDownload["platform"]): string =>
  p === "android" ? "Android" : p === "ios" ? "iOS" : p;

/**
 * Download button for the latest installer build. Renders nothing while the
 * list loads, is empty, or the route is unavailable: the callers all have a
 * layout that works without it.
 */
export function InstallerDownloadCard({ compact }: { compact?: boolean }) {
  const list = useInstallerDownloads();
  const latest = latestDownload(list.data);
  if (!latest) return null;
  return (
    <Card withBorder padding="md" mb="md">
      <Group justify="space-between" align="center" wrap="wrap">
        <div>
          <Text fw={600}>잉여톤 app</Text>
          <Text size="sm" c="dimmed">
            Installs the catalog apps on your device, keeps them updated, and
            tracks project issues. Latest: <strong>{latest.filename}</strong>
            {latest.version ? ` (v${latest.version})` : ""} ·{" "}
            {platformLabel(latest.platform)} · {fmtTime(latest.createdAt)}
          </Text>
        </div>
        <Group gap="sm">
          <Button
            component="a"
            href={latest.url}
            leftSection={<IconDownload size={16} />}
          >
            Download installer
            {latest.version ? ` v${latest.version}` : ""}
          </Button>
          {compact && (
            <Anchor component={Link} to="/installer" size="sm">
              All builds
            </Anchor>
          )}
        </Group>
      </Group>
    </Card>
  );
}

export function InstallerPage() {
  const list = useInstallerDownloads();
  if (list.loading && !list.data) return <Spinner />;
  return (
    <>
      <Title order={2} mb="sm">
        Installer
      </Title>
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {list.data?.untrusted && (
        <Notice kind="warn">
          The installer app&apos;s team is not admin-locked, so its builds are
          not served. An admin fixes this under Members → Installer app.
        </Notice>
      )}
      {list.data &&
        !list.data.untrusted &&
        list.data.downloads.length === 0 && (
          <Notice>
            No installer build is published yet. An admin picks the installer
            app under Members → Installer app; builds are listed here as soon as
            one is uploaded.
          </Notice>
        )}
      {/* Mounted only with data: a second observer while the query is in
          error state would refetch (staleTime 0), flip the page back to the
          spinner, unmount itself, and loop. */}
      {list.data && <InstallerDownloadCard />}
      {list.data && list.data.downloads.length > 0 && (
        <Stack gap="xs">
          {list.data.downloads.some((d) => d.platform === "android") && (
            <Text size="sm" c="dimmed">
              Android: open the APK on the device and allow installs from this
              source when asked. The installer then signs in with the same
              GitHub account and updates itself from this list.
            </Text>
          )}
          <Table striped withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>File</Table.Th>
                <Table.Th>Version</Table.Th>
                <Table.Th>Platform</Table.Th>
                <Table.Th>Published</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.data.downloads.map((d, i) => (
                <Table.Tr key={d.url}>
                  <Table.Td>
                    <Anchor
                      href={d.url}
                      aria-label={
                        i === 0 ? `${d.filename} (latest)` : undefined
                      }
                    >
                      {d.filename}
                    </Anchor>{" "}
                    {i === 0 && <Badge size="xs">latest</Badge>}
                  </Table.Td>
                  <Table.Td>{d.version ?? "—"}</Table.Td>
                  <Table.Td>{platformLabel(d.platform)}</Table.Td>
                  <Table.Td>{fmtTime(d.createdAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Stack>
      )}
    </>
  );
}
