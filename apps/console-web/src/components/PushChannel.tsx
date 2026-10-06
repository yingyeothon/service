import { Button, Code, Group, Text } from "@mantine/core";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useConfirm } from "../lib/confirm";
import { notify } from "../lib/notify";
import { pushProblem, saveBlob, serviceAccountProblem } from "../lib/push";
import { useAction } from "../lib/query";
import type { Channel, PushConfig } from "../types";
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
            auth channel as Bearer (<Code>{"{token, project}"}</Code>; up to 5
            devices per player). Your server sends with the API key as Bearer:{" "}
            <Code>{"{userIds, data?, notification?}"}</Code>, up to 500 user ids
            a call. Device tokens never leave the platform.
          </Text>
        </>
      ) : (
        <Text size="sm" c="dimmed">
          The state service is not deployed on this stage, so the token and send
          routes do not exist here yet.
        </Text>
      )}
    </>
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
