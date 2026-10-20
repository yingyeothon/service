import { Anchor, Button, Card, Group, Table, Text } from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";
import { Link, useSearchParams } from "react-router";
import { api, ApiError } from "../api";
import { DataTable } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { OpenAppButton } from "../components/OpenAppButton";
import { Notice } from "../components/ui";
import { isIosUserAgent } from "../lib/catalog";
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

const onIosDevice = (): boolean =>
  isIosUserAgent(navigator.userAgent, navigator.maxTouchPoints);

/**
 * The build this device should take (the route lists the newest build per
 * platform, newest first): an iPhone/iPad gets the iOS build it can install
 * over the air, anything else the newest build that is not iOS. Falls back
 * to the newest build of all.
 */
export const latestDownload = (
  list: InstallerList | undefined,
  ios = false,
): InstallerDownload | undefined => {
  const d = list?.downloads;
  return (
    (ios ? d?.find((x) => x.ios) : d?.find((x) => x.platform !== "ios")) ??
    d?.[0]
  );
};

const platformLabel = (p: InstallerDownload["platform"]): string =>
  p === "android" ? "Android" : p === "ios" ? "iOS" : p;

/**
 * Download button for the latest installer build. Renders nothing while the
 * list loads, is empty, or the route is unavailable: the callers all have a
 * layout that works without it.
 */
export function InstallerDownloadCard({ compact }: { compact?: boolean }) {
  const list = useInstallerDownloads();
  const ios = onIosDevice();
  const latest = latestDownload(list.data, ios);
  if (!latest) return null;
  const installUrl = ios ? latest.ios?.installUrl : undefined;
  const href = installUrl ?? latest.url;
  return (
    <Card padding="md" mb="md">
      <Group justify="space-between" align="center" wrap="wrap">
        <div>
          <Text fw={500}>잉여톤 app</Text>
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
            href={href}
            variant="default"
            leftSection={<IconDownload size={16} aria-hidden="true" />}
          >
            {installUrl ? "Install app" : "Download installer"}
            {latest.version ? ` v${latest.version}` : ""}
          </Button>
          <OpenAppButton />
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
  const downloads = list.data?.downloads;
  const ios = onIosDevice();
  const [params] = useSearchParams();
  // Where "Open app" lands on a phone without the app (lib/appHandoff.ts).
  const appMissing = params.get("app") === "missing";
  return (
    <>
      <PageHeader
        title="Installer"
        description="The newest build of the device installer per platform."
      />
      {appMissing && (
        <Notice kind="warn">
          This phone has no 잉여톤 app that can take a sign-in from the web
          (none installed, or older than 1.6.1). Install or update from the APK
          below, then tap <strong>Open app</strong> again.
        </Notice>
      )}
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
          <EmptyState
            title="No installer build is published yet."
            hint="An admin picks the installer app under Members → Installer app; builds are listed here as soon as one is uploaded."
          />
        )}
      {/* Mounted only with data: a second observer while the query is in
          error state would refetch (staleTime 0), flip the page back to the
          skeleton, unmount itself, and loop. */}
      {list.data && <InstallerDownloadCard />}
      {downloads?.some((d) => d.platform === "android") && (
        <Text size="sm" c="dimmed" mb="md">
          Android: open the APK on the device and allow installs from this
          source when asked. The installer then signs in with the same GitHub
          account and updates itself from this list.
        </Text>
      )}
      {(list.loading || (downloads && downloads.length > 0)) && (
        <DataTable
          columns={[
            { key: "file", label: "File" },
            { key: "version", label: "Version" },
            { key: "platform", label: "Platform" },
            { key: "published", label: "Published" },
          ]}
          rows={downloads}
          loading={list.loading && !list.data}
          rowKey={(d) => d.url}
          minWidth={560}
          empty={{ title: "No installer build is published yet." }}
          render={(d) => (
            <>
              <Table.Td>
                <Anchor href={d.url} size="sm" fw={500}>
                  {d.filename}
                </Anchor>
                {ios && d.ios && (
                  <Button
                    component="a"
                    href={d.ios.installUrl}
                    size="compact-sm"
                    variant="default"
                    ml="sm"
                  >
                    Install on this device
                  </Button>
                )}
              </Table.Td>
              <Table.Td>
                {d.version ?? "—"}
                {d.buildNumber ? ` (${d.buildNumber})` : ""}
              </Table.Td>
              <Table.Td>{platformLabel(d.platform)}</Table.Td>
              <Table.Td>{fmtTime(d.createdAt)}</Table.Td>
            </>
          )}
        />
      )}
    </>
  );
}
