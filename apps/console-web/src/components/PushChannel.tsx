import { Button, Code, Group, Table, Text, TextInput } from "@mantine/core";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useConfirm } from "../lib/confirm";
import { notify } from "../lib/notify";
import {
  BUNDLE_ID_HINT,
  BUNDLE_ID_MAX,
  bundleIdProblem,
  pushProblem,
  saveBlob,
  serviceAccountProblem,
} from "../lib/push";
import { useAction, useApiQuery } from "../lib/query";
import type {
  ApnsState,
  Channel,
  PushChannelStats,
  PushConfig,
} from "../types";
import { DataTable } from "./DataTable";
import { ResourceDrawer, useDrawerForm } from "./ResourceDrawer";
import { Section } from "./Section";
import { ServiceAccountField } from "./ServiceAccountField";
import { Badge, CopyField, CopyText, Notice } from "./ui";

/*
 * The push half of the channel page (docs/decisions.md *Push notifications
 * (Android, FCM)*): what the app embeds, the state routes it and the game
 * server call, and the team's own sender key. The key is write-only; only
 * the Firebase project it belongs to comes back.
 */

/** Why there is no `google-services.json` to download, or `null`. */
function noDownloadReason(c: Channel): string | null {
  if (c.registered) return null;
  return (c.config as PushConfig).sender === "team"
    ? "A team-sender channel has no platform registration: the app ships with the google-services.json of your own Firebase project."
    : "This channel has no platform registration, so there is no file to download.";
}

/** The Endpoints rows of a push channel, with the client config download. */
export function PushDetails({ c }: { c: Channel }) {
  const cfg = c.config as PushConfig;
  const act = useAction();
  const base = c.apiBase;
  const reason = noDownloadReason(c);
  const download = async () => {
    const file = await act.run(async () => {
      try {
        return await api.channelGoogleServices(c.id);
      } catch (e) {
        throw new Error(pushProblem(e, "download").message);
      }
    });
    if (file) saveBlob(file.blob, file.filename);
  };
  return (
    <>
      <CopyField label="Package name" value={cfg.packageName} />
      <CopyField label="Auth channel" value={cfg.authChannelId} />
      {c.teamProject !== undefined && (
        <CopyField label="Team project" value={c.teamProject} />
      )}
      <Text size="sm" c="dimmed" my="xs" component="div">
        Sender: {cfg.sender} ·{" "}
        <Badge tone={c.registered ? "ok" : "neutral"}>
          {c.registered ? "registered" : "not registered"}
        </Badge>{" "}
        {c.registered
          ? "in a Firebase project of the platform."
          : "on the platform."}
      </Text>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <Group gap="sm" my="xs" align="center">
        <Button
          variant="default"
          disabled={reason !== null || act.busy}
          loading={act.busy}
          onClick={() => void download()}
        >
          Download google-services.json
        </Button>
        {reason !== null && (
          <Text size="sm" c="dimmed" style={{ flex: 1, minWidth: 220 }}>
            {reason}
          </Text>
        )}
      </Group>
      {reason === null && (
        <Text size="sm" c="dimmed">
          Put the file in the Android module (<Code>app/</Code>). Its{" "}
          <Code>project_info.project_id</Code> is the <Code>project</Code> the
          app sends when it registers a device token.
        </Text>
      )}
      {base ? (
        <>
          <CopyField label="API base" value={base} />
          <CopyText
            label="Push routes"
            value={[
              `PUT ${base}/push/${c.id}/token`,
              `DELETE ${base}/push/${c.id}/token`,
              `POST ${base}/push/${c.id}/send`,
            ].join("\n")}
          />
          <Text size="sm" c="dimmed">
            The app registers and removes its FCM token with a player JWT of the
            auth channel as Bearer (<Code>{"{token, project, platform?}"}</Code>
            ; up to 5 devices per player). Your server sends with the API key as
            Bearer: <Code>{"{userIds, data?, notification?}"}</Code>, up to 500
            user ids a call. Device tokens never leave the platform.
          </Text>
        </>
      ) : (
        <Text size="sm" c="dimmed">
          The state service is not deployed on this stage, so the token and send
          routes do not exist here yet.
        </Text>
      )}
      {c.topic !== undefined && (
        <>
          <CopyField label="Broadcast topic" value={c.topic} />
          <Text size="sm" c="dimmed">
            After its token is registered the app subscribes to this topic (
            <Code>FirebaseMessaging.subscribeToTopic</Code>) and unsubscribes on
            sign-out; a device that never subscribed receives no broadcast.
          </Text>
        </>
      )}
    </>
  );
}

/** The badge of an APNs state. */
const APNS_BADGE: Record<ApnsState, { label: string; tone: string }> = {
  team: { label: "APNs: team", tone: "neutral" },
  pending: { label: "APNs pending", tone: "warn" },
  ready: { label: "APNs ready", tone: "ok" },
};

/** What an APNs state asks of whom; the `pending` one is the page's notice. */
export const APNS_TEXT: Record<ApnsState, string> = {
  team: "Your team registers this iOS app and uploads its own APNs credential in its own Firebase project; the platform holds no credential and only takes and sends the app's tokens.",
  pending:
    "The platform owner has to upload this app's own APNs certificate (.p12) before iOS devices receive anything. Do not upload the certificate to the console: hand it to the owner out of band. It expires yearly, and its renewal is a request to the owner.",
  ready:
    "The owner uploaded this app's APNs certificate (.p12). It expires yearly; ask the owner to renew it before it does.",
};

/**
 * The channel's iOS app (docs/decisions.md *Console app and push on iOS*
 * #8): one per channel beside the Android one, added at creation or here,
 * and fixed once set. Its APNs credential never passes through the console.
 */
export function PushIosSection({
  channel,
  owner,
  onChanged,
}: {
  channel: Channel;
  owner: boolean;
  /** The channel view the add answered. */
  onChanged: (c: Channel) => void;
}) {
  const cfg = channel.config as PushConfig;
  const bundle = cfg.iosBundleId;
  const team = cfg.sender === "team";
  const act = useAction();
  const dl = useAction();
  const drawer = useDrawerForm(() => ({ bundleId: "" }));
  const [fieldError, setFieldError] = useState<string | null>(null);
  const state = channel.apnsState;

  const open = () => {
    act.clear();
    setFieldError(null);
    drawer.open();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const bundleId = drawer.form.bundleId.trim();
    const local = bundleIdProblem(bundleId);
    setFieldError(local);
    if (local) return;
    const r = await act.run(async () => {
      try {
        return await api.addChannelIos(channel.id, bundleId);
      } catch (err) {
        const p = pushProblem(err, "ios");
        if (p.at === "iosBundleId") {
          setFieldError(p.message);
          return undefined;
        }
        throw p.at === "form" ? err : new Error(p.message);
      }
    });
    if (!r) return;
    drawer.close();
    onChanged(r);
    notify.done("iOS app added");
  };
  const download = async () => {
    const file = await dl.run(async () => {
      try {
        return await api.channelGoogleServiceInfo(channel.id);
      } catch (e) {
        throw new Error(pushProblem(e, "iosDownload").message);
      }
    });
    if (file) saveBlob(file.blob, file.filename);
  };

  return (
    <Section
      title="iOS app"
      description="A push channel holds one Android app and at most one iOS app. The iOS bundle id is fixed once set."
    >
      {bundle === undefined ? (
        <>
          <Text size="sm" my="xs">
            No iOS app: the channel reaches Android devices only.
          </Text>
          {owner && (
            <Group mt="sm">
              <Button variant="default" onClick={open}>
                Add iOS app
              </Button>
            </Group>
          )}
        </>
      ) : (
        <>
          <CopyField label="iOS bundle id" value={bundle} />
          {state !== undefined && (
            <Text size="sm" my="xs" component="div">
              <Badge tone={APNS_BADGE[state].tone}>
                {APNS_BADGE[state].label}
              </Badge>{" "}
              {state === "pending" ? null : APNS_TEXT[state]}
            </Text>
          )}
          {state === "pending" && (
            <Notice kind="warn">{APNS_TEXT.pending}</Notice>
          )}
          {team ? (
            <Text size="sm" c="dimmed" my="xs">
              A team-sender channel has no platform iOS registration: the app
              ships with the GoogleService-Info.plist of your own Firebase
              project.
            </Text>
          ) : (
            <>
              {dl.error && <Notice kind="error">{dl.error}</Notice>}
              <Group gap="sm" my="xs" align="center">
                <Button
                  variant="default"
                  disabled={!channel.iosRegistered || dl.busy}
                  loading={dl.busy}
                  onClick={() => void download()}
                >
                  Download GoogleService-Info.plist
                </Button>
                {!channel.iosRegistered && (
                  <Text size="sm" c="dimmed" style={{ flex: 1, minWidth: 220 }}>
                    The iOS app is not registered on the platform, so there is
                    no file to download.
                  </Text>
                )}
              </Group>
            </>
          )}
          <Text size="sm" c="dimmed">
            Add the plist to the Xcode app target. An iOS device registers its
            FCM token on the same route with{" "}
            <Code>{'{token, project, platform: "ios"}'}</Code>.
          </Text>
        </>
      )}
      <ResourceDrawer
        opened={drawer.opened}
        onClose={drawer.close}
        title="Add iOS app"
        submitLabel="Add iOS app"
        onSubmit={submit}
        busy={act.busy}
        disabled={drawer.form.bundleId.trim() === ""}
        error={drawer.opened ? act.error : null}
      >
        <TextInput
          label="iOS bundle id"
          description={`${BUNDLE_ID_HINT} Fixed once added: it cannot be changed or removed short of deleting the channel.`}
          value={drawer.form.bundleId}
          onChange={(e) => {
            setFieldError(null);
            drawer.patch({ bundleId: e.target.value });
          }}
          error={fieldError ?? undefined}
          required
          maxLength={BUNDLE_ID_MAX}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="com.example.game"
        />
        <Text size="sm" c="dimmed" mt="sm">
          {team
            ? "Nothing is registered on the platform: register the iOS app and upload its APNs credential in your own Firebase project."
            : "The app is registered in the platform's Firebase project that holds this channel. iOS devices receive nothing until the owner registers its APNs certificate."}
        </Text>
      </ResourceDrawer>
    </Section>
  );
}

/**
 * The team's own Firebase sender: register, rotate or remove its
 * service-account key. A platform channel gains a second sender with it; a
 * team-sender channel has no other, so its key can only be rotated.
 */
export function PushSenderKeyCard({
  channel,
  owner,
  onChanged,
  onReload,
}: {
  channel: Channel;
  owner: boolean;
  /** The channel view a write answered. */
  onChanged: (c: Channel) => void;
  /** After a removal, which answers no view. */
  onReload: () => Promise<void>;
}) {
  const cfg = channel.config as PushConfig;
  const has = channel.teamProject !== undefined;
  const teamOnly = cfg.sender === "team";
  const act = useAction();
  const removeAct = useAction();
  const confirm = useConfirm();
  const drawer = useDrawerForm(() => ({ key: "" }));
  const [fieldError, setFieldError] = useState<string | null>(null);

  const open = () => {
    act.clear();
    setFieldError(null);
    drawer.open();
  };
  const close = () => {
    // The pasted key does not outlive the drawer.
    drawer.patch({ key: "" });
    drawer.close();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const local = serviceAccountProblem(drawer.form.key);
    setFieldError(local);
    if (local) return;
    const r = await act.run(async () => {
      try {
        return await api.setChannelSenderKey(
          channel.id,
          drawer.form.key.trim(),
        );
      } catch (err) {
        const p = pushProblem(err, "senderKey");
        if (p.at === "serviceAccount") {
          setFieldError(p.message);
          return undefined;
        }
        throw p.at === "form" ? err : new Error(p.message);
      }
    });
    if (!r) return;
    close();
    onChanged(r);
    notify.done(has ? "Sender key rotated" : "Sender key registered");
  };
  const remove = async () => {
    const ok = await confirm({
      title: "Remove the team sender key?",
      message:
        "The channel stops sending to devices registered with your Firebase project at once. Their tokens stay until they go stale, so registering the key again revives them.",
      confirmLabel: "Remove sender key",
      danger: true,
    });
    if (!ok.ok) return;
    const r = await removeAct.run(() => api.removeChannelSenderKey(channel.id));
    if (!r) return;
    notify.done("Sender key removed");
    await onReload();
  };

  return (
    <Section
      title="Team sender key"
      description="A service-account key of your own Firebase project. With it the channel also takes device tokens of that project and sends to them with your key — the way off the platform's project."
    >
      {removeAct.error && <Notice kind="error">{removeAct.error}</Notice>}
      <Text size="sm" my="xs">
        {has ? (
          <>
            Registered for the Firebase project{" "}
            <Code>{channel.teamProject}</Code>. The key itself is never shown.
          </>
        ) : (
          "No team key: messages go out through the platform's Firebase project only."
        )}
      </Text>
      {owner && (
        <>
          <Group mt="sm">
            <Button variant="default" onClick={open}>
              {has ? "Rotate key" : "Register key"}
            </Button>
            {has && (
              <Button
                variant="default"
                disabled={teamOnly || removeAct.busy}
                onClick={() => void remove()}
              >
                Remove key
              </Button>
            )}
          </Group>
          {has && teamOnly && (
            <Text size="sm" c="dimmed" mt="xs">
              Remove is off: the key is this team-sender channel&rsquo;s only
              sender. Rotate it, or delete the channel.
            </Text>
          )}
        </>
      )}
      <ResourceDrawer
        opened={drawer.opened}
        onClose={close}
        title={has ? "Rotate sender key" : "Register sender key"}
        submitLabel={has ? "Rotate key" : "Register key"}
        onSubmit={submit}
        busy={act.busy}
        disabled={drawer.form.key.trim() === ""}
        error={drawer.opened ? act.error : null}
      >
        <ServiceAccountField
          value={drawer.form.key}
          onChange={(key) => {
            setFieldError(null);
            drawer.patch({ key });
          }}
          error={fieldError}
          description={
            has
              ? "Replaces the stored key at once. A key of another Firebase project moves the channel to that project; tokens of the old one can no longer be reached."
              : "The Firebase Cloud Messaging API must be enabled in its project."
          }
        />
      </ResourceDrawer>
    </Section>
  );
}

const NOWRAP = { whiteSpace: "nowrap" } as const;
const count = (v: number) => v.toLocaleString("en-US");

/** `12 of 10,000`, or `10,000 of 10,000 — full` once a new device is refused. */
export function tokenLine(s: PushChannelStats): string {
  return s.tokens.capped
    ? `${count(s.tokenCap)} of ${count(s.tokenCap)} — full: a new device is refused until tokens expire or the limit is raised`
    : `${count(s.tokens.count)} of ${count(s.tokenCap)}`;
}

/**
 * The channel's device tokens against `push.tokensPerChannel`, and what its
 * sends did over the last two weeks (`GET /channels/{id}/push/stats`).
 */
export function PushStatsSection({ channelId }: { channelId: string }) {
  const q = useApiQuery(["channel", channelId, "push", "stats"], () =>
    api.pushStats(channelId),
  );
  const s = q.data;
  return (
    <Section
      title="Delivery"
      description="Device tokens are counted up to the channel's limit. Send counters are per UTC day and cover targeted sends and campaign jobs (one call per batch of 500); broadcasts and the deferred-match hook are not counted."
    >
      {s && (
        <Text size="sm" mb="xs">
          Device tokens: {tokenLine(s)}
        </Text>
      )}
      <DataTable
        columns={[
          { key: "day", label: "Day (UTC)" },
          { key: "calls", label: "Calls", align: "right" },
          { key: "sent", label: "Reached", align: "right" },
          { key: "noToken", label: "No token", align: "right" },
          { key: "failed", label: "Failed", align: "right" },
          { key: "gone", label: "Tokens dropped", align: "right" },
        ]}
        rows={s?.days}
        loading={q.loading}
        error={q.error}
        rowKey={(d) => d.day}
        minWidth={560}
        empty={{
          title: "No sends in the last 14 days.",
          hint: s ? `Counted since ${s.since}.` : undefined,
        }}
        render={(d) => (
          <>
            <Table.Td style={NOWRAP}>{d.day}</Table.Td>
            <Table.Td style={{ ...NOWRAP, textAlign: "right" }}>
              {count(d.calls)}
            </Table.Td>
            <Table.Td style={{ ...NOWRAP, textAlign: "right" }}>
              {count(d.sent)}
            </Table.Td>
            <Table.Td style={{ ...NOWRAP, textAlign: "right" }}>
              {count(d.noToken)}
            </Table.Td>
            <Table.Td style={{ ...NOWRAP, textAlign: "right" }}>
              {count(d.failed)}
            </Table.Td>
            <Table.Td style={{ ...NOWRAP, textAlign: "right" }}>
              {count(d.unregistered)}
            </Table.Td>
          </>
        )}
      />
    </Section>
  );
}
