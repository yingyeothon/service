import {
  Checkbox,
  Fieldset,
  NativeSelect,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import type {
  Channel,
  ChannelKind,
  MatchMode,
  PushConfig,
  SayScope,
} from "../types";
import {
  MATCH_BOUNDS,
  SAY_SCOPES,
  withMatchMode,
  type ChannelFormState,
  type MatchFieldErrors,
} from "../lib/channelForm";
import { PACKAGE_NAME_HINT, PACKAGE_NAME_MAX } from "../lib/push";
import { ServiceAccountField } from "./ServiceAccountField";

/** A refusal that belongs to one push or match field, shown under it. */
export interface ChannelFieldErrors extends MatchFieldErrors {
  packageName?: string | null;
  serviceAccount?: string | null;
}

/**
 * The push channels a deferred match channel may name: active, and on the
 * same auth channel (the server's `requirePushChannel`; the list is already
 * the project's).
 */
function usablePushChannels(all: Channel[], authChannelId: string): Channel[] {
  return all.filter(
    (c) =>
      c.kind === "push" &&
      c.status === "active" &&
      authChannelId !== "" &&
      (c.config as PushConfig).authChannelId === authChannelId,
  );
}

const range = ([min, max]: readonly [number, number, number]) =>
  `${min}–${max}`;

interface Props {
  kind: ChannelKind;
  form: ChannelFormState;
  onChange: (f: ChannelFormState) => void;
  /** Auth channels the caller owns, for topic/match `authChannelId`. */
  authChannels: Channel[];
  /**
   * match: the project's push channels, for a deferred channel's picker.
   * `undefined` while they load.
   */
  pushChannels?: Channel[];
  /**
   * Editing an existing channel: auth provider secrets may be left blank to
   * keep them, and what is fixed at creation (push package and sender, match
   * mode) is shown disabled.
   */
  editing?: boolean;
  errors?: ChannelFieldErrors;
}

export function ChannelForm({
  kind,
  form,
  onChange,
  authChannels,
  pushChannels: loadedPushChannels,
  editing,
  errors,
}: Props) {
  const pushChannels = loadedPushChannels ?? [];
  const set = <K extends keyof ChannelFormState>(
    k: K,
    v: ChannelFormState[K],
  ) => onChange({ ...form, [k]: v });

  const authSelect = (
    <NativeSelect
      label="Auth channel"
      description={
        kind === "push"
          ? "Devices register their tokens with JWTs issued by this auth channel; a message is addressed to its user ids."
          : "Players connect with JWTs issued by this auth channel."
      }
      value={form.authChannelId}
      onChange={(e) => {
        const authChannelId = e.target.value;
        // A push channel belongs to one auth channel: it does not follow the
        // match channel to another.
        const keeps = usablePushChannels(pushChannels, authChannelId).some(
          (p) => p.id === form.pushChannelId,
        );
        onChange({
          ...form,
          authChannelId,
          pushChannelId: keeps ? form.pushChannelId : "",
        });
      }}
      required
      data={[
        { value: "", label: "— choose —" },
        ...authChannels.map((c) => ({
          value: c.id,
          label: `${c.name} (${c.id})`,
        })),
      ]}
    />
  );

  const deferred = form.matchMode === "deferred";
  const wait = MATCH_BOUNDS[form.matchMode].waitTimeoutSec;
  const pushOptions = usablePushChannels(pushChannels, form.authChannelId);
  // A stored link the picker cannot offer (expired, or left on another auth
  // channel) stays selected and named, so a Save never drops it unseen; the
  // server refuses it and the message lands under this field.
  const strayPush =
    form.pushChannelId !== "" &&
    !pushOptions.some((p) => p.id === form.pushChannelId);

  return (
    <>
      <TextInput
        label="Name"
        value={form.name}
        onChange={(e) => set("name", e.target.value)}
        required
        maxLength={100}
      />
      {kind === "auth" && (
        <>
          <TextInput
            label="Audience (the JWT aud claim)"
            value={form.audience}
            onChange={(e) => set("audience", e.target.value)}
            required
            maxLength={200}
            placeholder="my-game"
          />
          <TextInput
            label="Token TTL (seconds)"
            type="number"
            min={1}
            max={30 * 86400}
            value={form.tokenTtlSec}
            onChange={(e) => set("tokenTtlSec", e.target.value)}
            required
          />
          <Textarea
            label="Redirect allowlist (one absolute https URL per line, max 20)"
            description="After login, auth only redirects to URLs that start with one of these (origin + path boundary)."
            value={form.redirectAllowlist}
            onChange={(e) => set("redirectAllowlist", e.target.value)}
            autosize
            minRows={2}
            placeholder={
              "https://game.example.com/callback\nhttp://localhost:3000/callback"
            }
          />
          {(["github", "google"] as const).map((p) => {
            const enabled =
              p === "github" ? form.githubEnabled : form.googleEnabled;
            const idKey = p === "github" ? "githubClientId" : "googleClientId";
            const secKey =
              p === "github" ? "githubClientSecret" : "googleClientSecret";
            return (
              <Fieldset
                key={p}
                legend={
                  <Checkbox
                    label={`${p === "github" ? "GitHub" : "Google"} login`}
                    checked={enabled}
                    onChange={(e) =>
                      set(
                        p === "github" ? "githubEnabled" : "googleEnabled",
                        e.target.checked,
                      )
                    }
                  />
                }
              >
                {enabled && (
                  <>
                    <TextInput
                      label="Client id"
                      value={form[idKey]}
                      onChange={(e) => set(idKey, e.target.value)}
                      required
                    />
                    <TextInput
                      label="Client secret"
                      type="password"
                      autoComplete="off"
                      value={form[secKey]}
                      onChange={(e) => set(secKey, e.target.value)}
                      placeholder={
                        editing ? "leave blank to keep the stored secret" : ""
                      }
                    />
                  </>
                )}
              </Fieldset>
            );
          })}
        </>
      )}
      {(kind === "topic" || kind === "q") && authSelect}
      {kind === "q" && (
        <Text c="dimmed" size="sm">
          The Redis key prefixes this channel uses are derived from its id and
          shown on the channel page after it is created. Copy them into the game
          Lambda&rsquo;s tslib configuration unchanged — a prefix that differs
          on any side fails silently.
        </Text>
      )}
      {kind === "lobby" && (
        <>
          {authSelect}
          <Fieldset legend="Features">
            <Checkbox
              label="Positions — relay movement within a zone, with enter/leave"
              checked={form.capPos}
              onChange={(e) => set("capPos", e.target.checked)}
            />
            <Checkbox
              label="Party — create/invite/accept/leave, with a roster the game can read"
              checked={form.capParty}
              onChange={(e) => set("capParty", e.target.checked)}
            />
            <Checkbox
              label="Events — relay game-defined messages the gateway never reads"
              checked={form.capEvent}
              onChange={(e) => set("capEvent", e.target.checked)}
            />
            <Checkbox
              label="Debug commands (off unless you need them)"
              checked={form.capDebug}
              onChange={(e) => set("capDebug", e.target.checked)}
            />
            <Checkbox.Group
              label="Chat scopes"
              description="Zone chat needs positions; party chat needs the party feature."
              value={form.capSay}
              onChange={(v) => set("capSay", v as SayScope[])}
            >
              {SAY_SCOPES.map((sc) => (
                <Checkbox key={sc} value={sc} label={sc} />
              ))}
            </Checkbox.Group>
          </Fieldset>
          <TextInput
            label="Map URL"
            description="Immutable versioned asset on the platform CDN, sent to every client in the first frame. Changing it here is how a new map is published; leave blank for a channel with no map. URLs on other hosts are rejected."
            type="url"
            value={form.mapUrl}
            onChange={(e) => set("mapUrl", e.target.value)}
          />
          <TextInput
            label="Starting zone"
            description="Announced to a client on connect; every later zone change is the game API's call."
            value={form.defaultZone}
            onChange={(e) => set("defaultZone", e.target.value)}
            required
            maxLength={64}
          />
          <TextInput
            label="Relay interval (ms, 50–2000)"
            description="Also the tick the client is told to expect. 200 ms matches the dungeon."
            type="number"
            min={50}
            max={2000}
            value={form.flushIntervalMs}
            onChange={(e) => set("flushIntervalMs", e.target.value)}
            required
          />
          <TextInput
            label="Max move delta (tiles, 1–64)"
            description="Largest jump one movement message may carry. The gateway checks no terrain, only this."
            type="number"
            min={1}
            max={64}
            value={form.maxMoveDelta}
            onChange={(e) => set("maxMoveDelta", e.target.value)}
            required
          />
          <TextInput
            label="Rate limit (messages/second, 1–200)"
            type="number"
            min={1}
            max={200}
            value={form.rateLimit}
            onChange={(e) => set("rateLimit", e.target.value)}
            required
          />
          <TextInput
            label="Max party size (2–16)"
            type="number"
            min={2}
            max={16}
            value={form.partySizeMax}
            onChange={(e) => set("partySizeMax", e.target.value)}
            required
          />
          <TextInput
            label="Visible peers cap (1–256)"
            description="A player sees at most this many peers, nearest first. Always applied, so every frame fits the gateway's cap; enter/leave, positions and zone chat all follow the view."
            type="number"
            min={1}
            max={256}
            value={form.maxPeers}
            onChange={(e) => set("maxPeers", e.target.value)}
            disabled={!form.capPos}
            required
          />
          <TextInput
            label="View range (tiles, 1–256; empty = whole zone)"
            description="Area of interest: only peers within this many tiles on both axes are candidates for the view."
            type="number"
            min={1}
            max={256}
            value={form.aoiRange}
            onChange={(e) => set("aoiRange", e.target.value)}
            disabled={!form.capPos}
          />
        </>
      )}
      {kind === "push" && (
        <>
          {authSelect}
          <TextInput
            label="Package name"
            description={
              editing
                ? "Fixed at creation: the registration and every device token are bound to it."
                : PACKAGE_NAME_HINT
            }
            value={form.packageName}
            onChange={(e) => set("packageName", e.target.value)}
            error={errors?.packageName ?? undefined}
            disabled={editing}
            required
            maxLength={PACKAGE_NAME_MAX}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="com.example.game"
          />
          <NativeSelect
            label="Sender"
            description={
              editing
                ? "Fixed at creation."
                : "Who sends the messages. The platform sender needs nothing from you and counts toward the team's push apps limit."
            }
            value={form.pushSender}
            onChange={(e) =>
              set("pushSender", e.target.value as "platform" | "team")
            }
            disabled={editing}
            data={[
              {
                value: "platform",
                label: "platform — the platform's Firebase project",
              },
              {
                value: "team",
                label: "team — your own Firebase project and key",
              },
            ]}
          />
          {!editing && form.pushSender === "team" && (
            <ServiceAccountField
              value={form.teamServiceAccount}
              onChange={(v) => set("teamServiceAccount", v)}
              error={errors?.serviceAccount}
              description="A service-account key of your Firebase project with the Firebase Cloud Messaging API enabled. The app ships with that project's own google-services.json."
            />
          )}
          {!editing && form.pushSender === "platform" && (
            <Text size="sm" c="dimmed">
              The package is registered in a Firebase project of the platform;
              its google-services.json is downloaded from the channel page after
              it is created.
            </Text>
          )}
        </>
      )}
      {kind === "match" && (
        <>
          {authSelect}
          <TextInput
            label="Party size (2–16)"
            type="number"
            min={2}
            max={16}
            value={form.partySize}
            onChange={(e) => set("partySize", e.target.value)}
            error={errors?.partySize}
            required
          />
          <NativeSelect
            label="Mode"
            description={
              editing
                ? "Fixed at creation."
                : "How players wait. It cannot be changed after the channel is created."
            }
            value={form.matchMode}
            onChange={(e) =>
              onChange(withMatchMode(form, e.target.value as MatchMode))
            }
            disabled={editing}
            data={[
              {
                value: "live",
                label: "live — players wait on a WebSocket with the app open",
              },
              {
                value: "deferred",
                label:
                  "deferred — a ticket over HTTP; players accept the match later",
              },
            ]}
          />
          <TextInput
            label={`Wait timeout (seconds, ${range(wait)})`}
            description={
              deferred
                ? "Counted from the first time the ticket was queued."
                : undefined
            }
            type="number"
            value={form.waitTimeoutSec}
            onChange={(e) => set("waitTimeoutSec", e.target.value)}
            error={errors?.waitTimeoutSec}
            required
          />
          <NativeSelect
            label="On timeout"
            value={form.onTimeout}
            onChange={(e) =>
              set("onTimeout", e.target.value as "partial" | "fail")
            }
            data={[
              {
                value: "fail",
                label: "fail — tell waiting players no match was found",
              },
              {
                value: "partial",
                label: "partial — start with whoever is waiting",
              },
            ]}
          />
          <TextInput
            label="Callback URL (optional)"
            description="The match service POSTs each formed party here, signed with the channel API key. Leave it empty and no request is made: every member is told who else is in the party and they arrange the room themselves."
            type="url"
            value={form.callbackUrl}
            onChange={(e) => set("callbackUrl", e.target.value)}
            placeholder="https://dungeon.example.com/match"
          />
          {form.callbackUrl.trim() === "" && (
            <Text size="sm" c="dimmed">
              No callback: this channel is members-only. A formed party is{" "}
              {deferred
                ? "read from each member's ticket"
                : "announced to its own sockets"}{" "}
              and your game server is never called.
            </Text>
          )}
          {deferred && (
            <>
              <TextInput
                label={`Accept window (seconds, ${range(MATCH_BOUNDS.deferred.acceptTimeoutSec)})`}
                description="Every member of a proposed match must accept within it. It may close up to a minute late."
                type="number"
                value={form.acceptTimeoutSec}
                onChange={(e) => set("acceptTimeoutSec", e.target.value)}
                error={errors?.acceptTimeoutSec}
                required
              />
              <TextInput
                label={`Result TTL (seconds, ${range(MATCH_BOUNDS.deferred.resultTtlSec)})`}
                description="How long a finished ticket (confirmed, expired, declined or failed) stays readable."
                type="number"
                value={form.resultTtlSec}
                onChange={(e) => set("resultTtlSec", e.target.value)}
                error={errors?.resultTtlSec}
                required
              />
              <NativeSelect
                label="Push channel (optional)"
                description="Wakes the players' devices when a match is proposed, confirmed or expired. Lists the active push channels of this project on the auth channel above."
                value={form.pushChannelId}
                onChange={(e) => set("pushChannelId", e.target.value)}
                error={errors?.pushChannelId}
                data={[
                  { value: "", label: "none — clients poll their ticket" },
                  ...pushOptions.map((p) => ({
                    value: p.id,
                    label: `${p.name} (${p.id})`,
                  })),
                  ...(strayPush
                    ? [
                        {
                          value: form.pushChannelId,
                          label:
                            loadedPushChannels === undefined
                              ? form.pushChannelId
                              : `${form.pushChannelId} — not usable (expired, or on another auth channel)`,
                        },
                      ]
                    : []),
                ]}
              />
            </>
          )}
        </>
      )}
    </>
  );
}
