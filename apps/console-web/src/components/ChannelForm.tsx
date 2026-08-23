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
    <label className="field">
      Auth channel
      <select
        value={form.authChannelId}
        onChange={(e) => set("authChannelId", e.target.value)}
        required
      >
        <option value="">— choose —</option>
        {authChannels.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.id})
          </option>
        ))}
      </select>
      <small>Players connect with JWTs issued by this auth channel.</small>
    </label>
  );

  return (
    <>
      <label className="field">
        Name
        <input
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          required
          maxLength={100}
        />
      </label>
      {kind === "auth" && (
        <>
          <label className="field">
            Audience (the JWT aud claim)
            <input
              value={form.audience}
              onChange={(e) => set("audience", e.target.value)}
              required
              maxLength={200}
              placeholder="my-game"
            />
          </label>
          <label className="field">
            Token TTL (seconds)
            <input
              type="number"
              min={1}
              max={30 * 86400}
              value={form.tokenTtlSec}
              onChange={(e) => set("tokenTtlSec", e.target.value)}
              required
            />
          </label>
          <label className="field">
            Redirect allowlist (one absolute https URL per line, max 20)
            <textarea
              value={form.redirectAllowlist}
              onChange={(e) => set("redirectAllowlist", e.target.value)}
              placeholder={
                "https://game.example.com/callback\nhttp://localhost:3000/callback"
              }
            />
            <small>
              After login, auth only redirects to URLs that start with one of
              these (origin + path boundary).
            </small>
          </label>
          {(["github", "google"] as const).map((p) => {
            const enabled =
              p === "github" ? form.githubEnabled : form.googleEnabled;
            const idKey = p === "github" ? "githubClientId" : "googleClientId";
            const secKey =
              p === "github" ? "githubClientSecret" : "googleClientSecret";
            return (
              <fieldset key={p}>
                <legend>
                  <label>
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) =>
                        set(
                          p === "github" ? "githubEnabled" : "googleEnabled",
                          e.target.checked,
                        )
                      }
                    />{" "}
                    {p === "github" ? "GitHub" : "Google"} login
                  </label>
                </legend>
                {enabled && (
                  <>
                    <label className="field">
                      Client id
                      <input
                        value={form[idKey]}
                        onChange={(e) => set(idKey, e.target.value)}
                        required
                      />
                    </label>
                    <label className="field">
                      Client secret
                      <input
                        type="password"
                        autoComplete="off"
                        value={form[secKey]}
                        onChange={(e) => set(secKey, e.target.value)}
                        placeholder={
                          editing ? "leave blank to keep the stored secret" : ""
                        }
                      />
                    </label>
                  </>
                )}
              </fieldset>
            );
          })}
        </>
      )}
      {kind === "topic" && authSelect}
      {kind === "match" && (
        <>
          {authSelect}
          <label className="field">
            Party size (2–16)
            <input
              type="number"
              min={2}
              max={16}
              value={form.partySize}
              onChange={(e) => set("partySize", e.target.value)}
              required
            />
          </label>
          <label className="field">
            Wait timeout (seconds, 5–600)
            <input
              type="number"
              min={5}
              max={600}
              value={form.waitTimeoutSec}
              onChange={(e) => set("waitTimeoutSec", e.target.value)}
              required
            />
          </label>
          <label className="field">
            On timeout
            <select
              value={form.onTimeout}
              onChange={(e) =>
                set("onTimeout", e.target.value as "partial" | "fail")
              }
            >
              <option value="fail">
                fail — tell waiting players no match was found
              </option>
              <option value="partial">
                partial — start with whoever is waiting
              </option>
            </select>
          </label>
          <label className="field">
            Callback URL
            <input
              type="url"
              value={form.callbackUrl}
              onChange={(e) => set("callbackUrl", e.target.value)}
              required
              placeholder="https://dungeon.example.com/match"
            />
            <small>
              The match service POSTs each formed party here, signed with the
              channel API key.
            </small>
          </label>
        </>
      )}
    </>
  );
}
