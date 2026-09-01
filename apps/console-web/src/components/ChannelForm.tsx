import {
  Checkbox,
  Fieldset,
  NativeSelect,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import type { Channel, ChannelKind, SayScope } from "../types";
import { SAY_SCOPES, type ChannelFormState } from "../lib/channelForm";

interface Props {
  kind: ChannelKind;
  form: ChannelFormState;
  onChange: (f: ChannelFormState) => void;
  /** Auth channels the caller owns, for topic/match `authChannelId`. */
  authChannels: Channel[];
  /** Editing an existing auth channel: provider secrets may be left blank to keep them. */
  editing?: boolean;
}

export function ChannelForm({
  kind,
  form,
  onChange,
  authChannels,
  editing,
}: Props) {
  const set = <K extends keyof ChannelFormState>(
    k: K,
    v: ChannelFormState[K],
  ) => onChange({ ...form, [k]: v });

  const authSelect = (
    <NativeSelect
      label="Auth channel"
      description="Players connect with JWTs issued by this auth channel."
      value={form.authChannelId}
      onChange={(e) => set("authChannelId", e.target.value)}
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
            label="View range (tiles, 1–256; empty = whole zone)"
            description="Area of interest: a player sees peers within this many tiles on both axes. Enter/leave, positions and zone chat all follow the view."
            type="number"
            min={1}
            max={256}
            value={form.aoiRange}
            onChange={(e) => set("aoiRange", e.target.value)}
            disabled={!form.capPos}
          />
          <TextInput
            label="Visible peers cap (1–256)"
            description="Nearest peers shown when more than this are within range."
            type="number"
            min={1}
            max={256}
            value={form.aoiMaxPeers}
            onChange={(e) => set("aoiMaxPeers", e.target.value)}
            disabled={!form.capPos || form.aoiRange.trim() === ""}
          />
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
            required
          />
          <TextInput
            label="Wait timeout (seconds, 5–600)"
            type="number"
            min={5}
            max={600}
            value={form.waitTimeoutSec}
            onChange={(e) => set("waitTimeoutSec", e.target.value)}
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
            label="Callback URL"
            description="The match service POSTs each formed party here, signed with the channel API key."
            type="url"
            value={form.callbackUrl}
            onChange={(e) => set("callbackUrl", e.target.value)}
            required
            placeholder="https://dungeon.example.com/match"
          />
        </>
      )}
    </>
  );
}
