import {
  Button,
  Divider,
  Group,
  Modal,
  NativeSelect,
  Paper,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { fmtRelative, fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import { useAction, useApiQuery } from "../lib/query";
import {
  SHARE_BUILD_KINDS,
  SHARE_LINK_DAYS,
  type CatalogApp,
  type CatalogArtifact,
  type ShareBuildKind,
  type CreatedShareLink,
  type ShareLink,
  type ShareLinkDays,
} from "../types";
import { DataTable } from "./DataTable";
import { RowMenu } from "./RowMenu";
import { Badge, CopyField, Notice } from "./ui";

/*
 * The app page's Share dialog (docs/decisions.md *Catalog share links and
 * install bridge* #7): the permanent public link while the listing is
 * public, a token link minted on demand, and the team's links with revoke.
 * A token URL is a bearer capability returned only by create: it lives in
 * this component's state and nowhere else (no storage, URL or history), and
 * closing the dialog unmounts the body and forgets it.
 */

const NOWRAP = { whiteSpace: "nowrap" } as const;
const clip = (width: number) =>
  ({
    display: "block",
    width,
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  }) as const;

const DAYS_LABEL: Record<ShareLinkDays, string> = {
  1: "1 day",
  7: "7 days",
  30: "30 days",
};

const KIND_LABEL: Record<ShareBuildKind, string> = {
  "android-release": "Android release APK",
  "android-debug": "Android debug APK",
  "ios-ad-hoc": "iOS ad-hoc",
};

/**
 * The kinds the app has a build for, by the server's rule (`artifactOfKind`
 * in services/console/src/share-links.ts): an `.apk` tagged `build_type`
 * debug/release, or an iOS build with an ad-hoc install URL.
 */
export function availableKinds(
  artifacts: CatalogArtifact[] | undefined,
): ShareBuildKind[] {
  if (!artifacts) return [];
  const has = (k: ShareBuildKind) =>
    artifacts.some((a) => {
      if (k === "ios-ad-hoc") return a.platform === "ios" && !!a.ios;
      const type = k === "android-debug" ? "debug" : "release";
      const file = (a.objectKey ?? a.url).split("?")[0] ?? "";
      return (
        a.platform === "android" &&
        a.tags.build_type === type &&
        /\.apk$/i.test(file)
      );
    });
  return SHARE_BUILD_KINDS.filter(has);
}

export const shareLinksKey = (appId: string) => [
  "catalog",
  "app",
  appId,
  "share-links",
];

/** Web Share where the browser has it, plus X and LINE share URLs. */
export function ShareButtons({ url, title }: { url: string; title: string }) {
  const text = `Install ${title}`;
  const canShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";
  const share = async () => {
    try {
      await navigator.share({ title, text, url });
    } catch {
      // Dismissed sheet (AbortError) or a refusal: nothing to report.
    }
  };
  const x = `https://x.com/intent/post?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  const line = `https://line.me/R/share?text=${encodeURIComponent(`${text} ${url}`)}`;
  return (
    <Stack gap={4}>
      <Group gap="xs" wrap="wrap">
        {canShare && (
          <Button size="xs" variant="default" onClick={() => void share()}>
            Share…
          </Button>
        )}
        <Button
          size="xs"
          variant="default"
          component="a"
          href={x}
          target="_blank"
          rel="noopener noreferrer"
        >
          Post on X
        </Button>
        <Button
          size="xs"
          variant="default"
          component="a"
          href={line}
          target="_blank"
          rel="noopener noreferrer"
        >
          Send with LINE
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        KakaoTalk and Slack: use Copy, or Share… on a phone.
      </Text>
    </Stack>
  );
}

/** QR of the link, rendered locally; `qrcode` loads only when one is shown. */
function LinkQr({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void import("qrcode")
      .then((m) =>
        m.default.toDataURL(url, {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 200,
        }),
      )
      .then((d) => {
        if (live) setSrc(d);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [url]);
  if (!src) return null;
  return (
    <img
      src={src}
      alt="QR code of the share link"
      width={160}
      height={160}
      style={{ maxWidth: "100%", height: "auto" }}
    />
  );
}

function statusOf(l: ShareLink): { label: string; tone: string } {
  if (l.revokedAt !== null) return { label: "revoked", tone: "neutral" };
  if (!l.live) return { label: "expired", tone: "neutral" };
  return { label: "live", tone: "ok" };
}

function ShareBody({
  app,
  canWrite,
  artifacts,
  seatless,
}: {
  app: CatalogApp;
  canWrite: boolean;
  artifacts?: CatalogArtifact[];
  seatless: boolean;
}) {
  const queryClient = useQueryClient();
  const key = shareLinksKey(app.id);
  const list = useApiQuery(key, () => api.shareLinks(app.id));
  const create = useAction();
  const revokeAct = useAction();
  const [days, setDays] = useState<ShareLinkDays>(7);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<ShareBuildKind | "">("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [reason, setReason] = useState("");
  const kinds = availableKinds(artifacts);
  const [created, setCreated] = useState<CreatedShareLink | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  // A phone (390 px) cannot hold four columns plus the row menu inside the
  // dialog: below `sm` the creator is dropped and status merges into Expires.
  const narrow = useMediaQuery("(max-width: 48em)") ?? false;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = label.trim();
    // Only the keys the user set (decision #10): blank means "not given".
    const t = title.trim();
    const sm = summary.trim();
    const why = reason.trim();
    const r = await create.run(async () => {
      try {
        return await api.createShareLink(app.id, {
          expiresInDays: days,
          ...(trimmed ? { label: trimmed } : {}),
          ...(kind ? { buildKind: kind } : {}),
          ...(t ? { title: t } : {}),
          ...(sm ? { summary: sm } : {}),
          ...(seatless && why ? { reason: why } : {}),
        });
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 409)
          throw new Error(
            `This app already has ${list.data?.limit ?? 20} live links. Revoke one first.`,
          );
        throw err;
      }
    });
    if (!r) return;
    setCreated(r);
    setLabel("");
    setTitle("");
    setSummary("");
    setReason("");
    notify.created("share link");
    await refresh();
  };

  const revoke = async (l: ShareLink) => {
    const ok = await revokeAct.run(async () => {
      await api.revokeShareLink(app.id, l.id);
      return true;
    });
    if (!ok) return;
    notify.done("Share link revoked");
    await refresh();
  };

  const publicUrl = list.data?.publicUrl ?? null;
  const nameOf = (l: ShareLink) =>
    l.label ?? l.title ?? `link created ${fmtTime(l.createdAt)}`;

  return (
    <Stack gap="md">
      <Stack gap="xs">
        <Title order={2} size="h4">
          Public link
        </Title>
        {publicUrl ? (
          <>
            <Text size="sm" c="dimmed">
              Works while the listing is public; anyone may open it.
            </Text>
            <CopyField label="Public link" value={publicUrl} />
            <ShareButtons url={publicUrl} title={app.name} />
          </>
        ) : list.error ? (
          <Notice kind="error">{list.error}</Notice>
        ) : (
          <Text size="sm" c="dimmed">
            {list.data
              ? "Publish the app for everyone to get a permanent link. Until then, share a link below."
              : "Loading…"}
          </Text>
        )}
      </Stack>

      {canWrite && (
        <>
          <Divider />
          <Stack gap="xs">
            <Title order={2} size="h4">
              New link
            </Title>
            <Text size="sm" c="dimmed">
              Anyone holding the link installs the newest build of each platform
              — or only the build kind you pick — until it expires or is
              revoked.
            </Text>
            {create.error && <Notice kind="error">{create.error}</Notice>}
            {created ? (
              <Paper
                role="status"
                p="md"
                withBorder={false}
                style={{
                  background: "var(--yyt-signature-cream)",
                  color: "var(--yyt-ink)",
                }}
              >
                <Text size="sm" mb="xs">
                  <strong>Share link</strong> — shown once. Copy or share it
                  now; it cannot be retrieved later. Expires{" "}
                  {fmtTime(created.expiresAt)}.
                </Text>
                <CopyField label="Share link" value={created.url} />
                <Group align="flex-start" gap="md" mt="xs" wrap="wrap">
                  <LinkQr url={created.url} />
                  <ShareButtons url={created.url} title={app.name} />
                </Group>
                <Button
                  variant="default"
                  mt="sm"
                  onClick={() => setCreated(null)}
                >
                  Done
                </Button>
              </Paper>
            ) : (
              <form onSubmit={(e) => void submit(e)}>
                <Stack gap="xs">
                  <Group align="end" wrap="wrap">
                    <NativeSelect
                      label="Build"
                      value={kind}
                      data={[
                        { value: "", label: "Newest of each platform" },
                        ...kinds.map((k) => ({
                          value: k,
                          label: KIND_LABEL[k],
                        })),
                      ]}
                      onChange={(e) =>
                        setKind(e.currentTarget.value as ShareBuildKind | "")
                      }
                      w={220}
                    />
                    <NativeSelect
                      label="Expires in"
                      value={String(days)}
                      data={SHARE_LINK_DAYS.map((d) => ({
                        value: String(d),
                        label: DAYS_LABEL[d],
                      }))}
                      onChange={(e) =>
                        setDays(Number(e.currentTarget.value) as ShareLinkDays)
                      }
                      w={120}
                    />
                    <TextInput
                      label="Label"
                      placeholder="Optional: who it is for"
                      value={label}
                      maxLength={100}
                      onChange={(e) => setLabel(e.currentTarget.value)}
                      w={240}
                      autoComplete="off"
                    />
                  </Group>
                  <TextInput
                    label="Link title"
                    description="Shown to recipients instead of the app name. Optional."
                    value={title}
                    maxLength={100}
                    onChange={(e) => setTitle(e.currentTarget.value)}
                    autoComplete="off"
                  />
                  <Textarea
                    label="Link summary"
                    description="Shown on the install page. Optional."
                    value={summary}
                    maxLength={2000}
                    autosize
                    minRows={2}
                    maxRows={6}
                    onChange={(e) => setSummary(e.currentTarget.value)}
                  />
                  {seatless && (
                    <TextInput
                      label="Reason"
                      description="You hold no seat on this team: the reason goes to the audit log."
                      value={reason}
                      maxLength={500}
                      required
                      onChange={(e) => setReason(e.currentTarget.value)}
                      autoComplete="off"
                    />
                  )}
                  <Group>
                    <Button
                      type="submit"
                      variant="default"
                      loading={create.busy}
                      disabled={seatless && !reason.trim()}
                    >
                      Create link
                    </Button>
                  </Group>
                </Stack>
              </form>
            )}
          </Stack>
        </>
      )}

      <Divider />
      <Stack gap="xs">
        <Title order={2} size="h4">
          Links
        </Title>
        {revokeAct.error && <Notice kind="error">{revokeAct.error}</Notice>}
        <DataTable
          columns={
            narrow
              ? [
                  { key: "label", label: "Label" },
                  { key: "expires", label: "Expires" },
                ]
              : [
                  { key: "label", label: "Label" },
                  { key: "createdBy", label: "Created by" },
                  { key: "expires", label: "Expires" },
                  { key: "status", label: "Status" },
                ]
          }
          minWidth={narrow ? 0 : 560}
          rows={list.data?.links}
          loading={list.loading}
          // The public-link section already shows the error.
          error={list.error ? "Could not load the links." : null}
          rowKey={(l) => l.id}
          empty={{ title: "No share links yet." }}
          render={(l) => {
            const st = statusOf(l);
            return (
              <>
                <Table.Td style={NOWRAP}>
                  <Text
                    span
                    size="sm"
                    style={clip(narrow ? 120 : 180)}
                    title={nameOf(l)}
                  >
                    {l.label ?? l.title ?? (
                      <Text span size="sm" c="dimmed">
                        —
                      </Text>
                    )}
                  </Text>
                  {l.buildKind && (
                    <Text
                      span
                      size="xs"
                      c="dimmed"
                      style={clip(narrow ? 120 : 180)}
                    >
                      {KIND_LABEL[l.buildKind] ?? l.buildKind}
                    </Text>
                  )}
                </Table.Td>
                {!narrow && (
                  <Table.Td style={NOWRAP}>
                    <Text span size="sm" style={clip(110)}>
                      {l.createdBy ?? "—"}
                    </Text>
                  </Table.Td>
                )}
                <Table.Td style={NOWRAP}>
                  {narrow && !l.live ? (
                    <Badge tone={st.tone}>{st.label}</Badge>
                  ) : (
                    <Text span size="sm" title={fmtTime(l.expiresAt)}>
                      {fmtRelative(l.expiresAt)}
                    </Text>
                  )}
                </Table.Td>
                {!narrow && (
                  <Table.Td style={NOWRAP}>
                    <Badge tone={st.tone}>{st.label}</Badge>
                  </Table.Td>
                )}
              </>
            );
          }}
          actions={
            canWrite
              ? (l) => (
                  <RowMenu
                    name={nameOf(l)}
                    items={
                      l.live
                        ? [
                            {
                              label: "Revoke",
                              danger: true,
                              disabled: revokeAct.busy,
                              onClick: () => revoke(l),
                              confirm: {
                                title: `Revoke ${nameOf(l)}?`,
                                message:
                                  "The link stops working at once. A build someone already downloaded stays with them.",
                                confirmLabel: "Revoke link",
                                danger: true,
                              },
                            },
                          ]
                        : []
                    }
                  />
                )
              : undefined
          }
        />
        {list.data && (
          <Text size="xs" c="dimmed">
            Up to {list.data.limit} live links per app.
          </Text>
        )}
      </Stack>
    </Stack>
  );
}

/**
 * The Share dialog. Its body mounts only while open, so a shown-once URL
 * never outlives the dialog.
 */
export function ShareModal({
  app,
  opened,
  onClose,
  canWrite,
  artifacts,
  seatless = false,
}: {
  app: CatalogApp;
  opened: boolean;
  onClose: () => void;
  canWrite: boolean;
  /** The app page's loaded builds, for the build-kind choice. */
  artifacts?: CatalogArtifact[];
  /** A platform admin with no seat on the app's team (asks for a reason). */
  seatless?: boolean;
}) {
  const narrow = useMediaQuery("(max-width: 48em)") ?? false;
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`Share ${app.name}`}
      size="lg"
      // Full width on a phone: every pixel goes to the links table.
      fullScreen={narrow}
      zIndex={300}
      closeButtonProps={{ "aria-label": "Close share dialog" }}
    >
      {opened && (
        <ShareBody
          app={app}
          canWrite={canWrite}
          artifacts={artifacts}
          seatless={seatless}
        />
      )}
    </Modal>
  );
}
