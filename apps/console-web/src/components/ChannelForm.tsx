import {
  Checkbox,
  Fieldset,
  NativeSelect,
  TextInput,
  Textarea,
} from "@mantine/core";
import type { Channel, ChannelKind } from "../types";
import type { ChannelFormState } from "../lib/channelForm";

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
      {kind === "topic" && authSelect}
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
