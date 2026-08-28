import { Button, Card, Code, Group, Stack, Text, Title } from "@mantine/core";
import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { ChannelForm } from "../components/ChannelForm";
import { Crumbs } from "../components/Crumbs";
import {
  Badge,
  Confirm,
  CopyBlock,
  CopyField,
  Notice,
  SecretOnce,
  Spinner,
} from "../components/ui";
import { buildConfig, emptyForm, formFromChannel } from "../lib/channelForm";
import { errorMessage, fmtRelative, fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";
import { projectUrl, useTeamStanding } from "../lib/team";
import { GATEWAY_KINDS } from "../types";
import type {
  AuthConfig,
  Channel,
  LobbyConfig,
  MatchConfig,
  QConfig,
  TopicConfig,
} from "../types";

export function ChannelDetailPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const loc = useLocation();
  const ch = useApiQuery(["channel", id], () => api.channel(id));
  const projectId = ch.data?.projectId ?? null;
  // Sibling auth channels for the edit form: same project only.
  const auths = useApiQuery(
    ["project", projectId, "channels", "auth"],
    () => api.projectChannels(projectId ?? "", "auth"),
    { enabled: projectId !== null },
  );
  const standing = useTeamStanding(ch.data?.teamId);
  const act = useAction();
  const [shown, setShown] = useState<string | null>(
    (loc.state as { shown?: string } | null)?.shown ?? null,
  );
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    // Drop the once-shown secret from history state so back/forward never re-shows it.
    if ((loc.state as { shown?: string } | null)?.shown)
      void nav(loc.pathname, { replace: true, state: null });
  }, [loc.state, loc.pathname, nav]);

  if (ch.error) return <Notice kind="error">{ch.error}</Notice>;
  if (!ch.data) return <Spinner />;
  const c = ch.data;
  // Members of the team write (secrets included); a platform admin without a
  // seat, or anyone on a legacy row with no team, only reads.
  const owner = standing.canWrite;
  // lobby/q hold no secret: the gateway verifies tokens by calling auth and
  // neither kind has a server-to-server caller, so there is nothing to rotate.
  const hasSecret = !(GATEWAY_KINDS as readonly string[]).includes(c.kind);
  const secretLabel = c.kind === "auth" ? "Channel secret" : "API key";

  const startEdit = () => {
    setForm(formFromChannel(c));
    setEditing(true);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    let config: unknown;
    try {
      config = buildConfig(c.kind, form, "patch", c);
      setLocalError(null);
    } catch (err) {
      setLocalError(errorMessage(err));
      return;
    }
    const r = await act.run(() =>
      api.updateChannel(c.id, { name: form.name.trim(), config }),
    );
    if (r) {
      ch.set(r);
      setEditing(false);
    }
  };
  const extend = async () => {
    const r = await act.run(() => api.extendChannel(c.id));
    if (r) ch.set(r);
  };
  const rotate = async () => {
    const r = await act.run(() => api.rotateChannelSecret(c.id));
    if (r) {
      setShown(r.secret ?? r.apiKey ?? null);
      ch.set(r);
    }
  };
  const remove = async () => {
    const ok = await act.run(async () => {
      await api.deleteChannel(c.id);
      return true;
    });
    if (ok)
      void nav(
        c.teamId && c.projectId
          ? projectUrl(c.teamId, c.projectId, "channels")
          : "/channels",
      );
  };

  return (
    <>
      <Crumbs
        crumbs={c}
        current={c.name}
        fallback={{ label: "Channels", to: "/channels" }}
      />
      <Group gap="xs" mb="sm">
        <Title order={2}>{c.name}</Title>
        <Badge>{c.kind}</Badge>
        <Badge
          tone={
            c.status === "active"
              ? "ok"
              : c.status === "expired"
                ? "warn"
                : "danger"
          }
        >
          {c.status}
        </Badge>
      </Group>
      {!owner && !standing.loading && (
        <Notice>
          Read-only: you are not seated in this channel&rsquo;s team. Platform
          admins can extend or delete, but never edit, rotate or issue
          credentials.
        </Notice>
      )}
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {shown && (
        <SecretOnce
          label={secretLabel}
          value={shown}
          onDismiss={() => setShown(null)}
        />
      )}

      <Card withBorder mb="md">
        <CopyField label="Channel id" value={c.id} />
        <Text size="sm" c="dimmed">
          Created by {c.createdBy ?? "—"}
        </Text>
        {c.kind === "auth" && <AuthDetails c={c} />}
        {c.kind === "topic" && <TopicDetails c={c} />}
        {c.kind === "match" && <MatchDetails c={c} />}
        {c.kind === "lobby" && <LobbyDetails c={c} />}
        {c.kind === "q" && <QDetails c={c} />}
        <Text size="sm" c="dimmed" my="xs">
          Created {fmtTime(c.createdAt)} · Expires {fmtTime(c.expiresAt)} (
          {fmtRelative(c.expiresAt)})
          {c.disabledAt !== null && <> · Disabled {fmtTime(c.disabledAt)}</>}
        </Text>
        <Group>
          <Button
            size="compact-sm"
            variant="default"
            disabled={act.busy}
            onClick={() => void extend()}
          >
            Extend +7 days
          </Button>
          {owner && !editing && (
            <Button
              size="compact-sm"
              variant="default"
              disabled={act.busy}
              onClick={startEdit}
            >
              Edit
            </Button>
          )}
          {owner && hasSecret && (
            <Confirm
              label={`Rotate ${secretLabel.toLowerCase()}`}
              color="brand"
              variant="default"
              onConfirm={rotate}
              disabled={act.busy}
            />
          )}
          <Confirm label="Delete" onConfirm={remove} disabled={act.busy} />
        </Group>
      </Card>

      {c.kind === "q" && <QRedisUserCard channel={c} owner={owner} />}
      {c.kind === "auth" && c.docUrl && (
        <AuthDocKeyCard channel={c} owner={owner} />
      )}

      {editing && (
        <Card withBorder>
          <form onSubmit={(e) => void save(e)}>
            <Stack gap="sm">
              <Title order={4}>Edit</Title>
              <ChannelForm
                kind={c.kind}
                form={form}
                onChange={setForm}
                authChannels={auths.data ?? []}
                editing
              />
              {localError && <Notice kind="error">{localError}</Notice>}
              <Group>
                <Button type="submit" disabled={act.busy}>
                  Save
                </Button>
                <Button variant="default" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </Group>
            </Stack>
          </form>
        </Card>
      )}
    </>
  );
}

function AuthDetails({ c }: { c: Channel }) {
  const cfg = c.config as AuthConfig;
  const providers = Object.keys(cfg.providers);
  return (
    <>
      <CopyField label="Issuer" value={c.issuer ?? ""} />
      <CopyField label="Audience" value={cfg.audience} />
      <CopyField label="Start URL" value={c.startUrl ?? ""} />
      {Object.entries(c.callbackUrls ?? {}).map(([p, url]) => (
        <CopyField key={p} label={`${p} callback`} value={url} />
      ))}
      <Text size="sm" c="dimmed">
        Token TTL {cfg.tokenTtlSec}s · Providers:{" "}
        {providers.length
          ? providers.join(", ")
          : "none (set one to enable login)"}
      </Text>
      <Text size="sm" c="dimmed">
        Redirect allowlist:{" "}
        {cfg.redirectAllowlist.length ? (
          cfg.redirectAllowlist.map((u) => (
            <Code key={u} mr={6}>
              {u}
            </Code>
          ))
        ) : (
          <em>empty — logins cannot redirect anywhere</em>
        )}
      </Text>
      <Text size="sm" c="dimmed">
        Register the callback URL{providers.length > 1 ? "s" : ""} above in the
        OAuth app{providers.length > 1 ? "s" : ""}. Games verify JWTs with
        issuer <Code>{c.issuer}</Code> and audience <Code>{cfg.audience}</Code>.
      </Text>
    </>
  );
}

function TopicDetails({ c }: { c: Channel }) {
  const cfg = c.config as TopicConfig;
  return (
    <>
      <CopyField label="API base" value={c.apiBase ?? ""} />
      <CopyField label="WebSocket URL" value={c.wsUrl ?? ""} />
      <CopyField label="Auth channel" value={cfg.authChannelId} />
      <Text size="sm" c="dimmed">
        Create topics with <Code>POST {c.apiBase}/t</Code> using the API key as
        Bearer; clients subscribe over the WebSocket with a player JWT.
      </Text>
    </>
  );
}

function LobbyDetails({ c }: { c: Channel }) {
  const cfg = c.config as LobbyConfig;
  const caps = [
    cfg.capabilities.pos && "positions",
    cfg.capabilities.say.length && `chat (${cfg.capabilities.say.join(", ")})`,
    cfg.capabilities.party && "party",
    cfg.capabilities.event && "events",
    cfg.capabilities.debug && "debug",
  ].filter(Boolean) as string[];
  return (
    <>
      <CopyField label="WebSocket URL" value={c.wsUrl ?? ""} />
      <CopyField label="Auth channel" value={cfg.authChannelId} />
      {cfg.mapUrl !== "" && <CopyField label="Map URL" value={cfg.mapUrl} />}
      <Text size="sm" c="dimmed">
        Features: {caps.length ? caps.join(" · ") : <em>none enabled</em>}
      </Text>
      <Text size="sm" c="dimmed">
        Starting zone <Code>{cfg.defaultZone}</Code> · relay every{" "}
        {cfg.flushIntervalMs}ms · up to {cfg.rateLimit} msg/s per player · move
        delta ≤ {cfg.maxMoveDelta} · party ≤ {cfg.partySizeMax}
      </Text>
      <Text size="sm" c="dimmed">
        Clients connect with a player JWT from the auth channel and are told the
        map URL and the enabled features in the first frame. Publishing a new
        map is an edit to the map URL here — nothing is cached against it.
      </Text>
    </>
  );
}

/**
 * The scoped Redis account a `q` channel's game Lambda logs in with. Separate
 * from the channel's own card because it is **not** a channel secret: `q`
 * stores none, `rotate-secret` refuses it, and this credential lives in Redis'
 * ACL rather than in the channel row.
 */
function QRedisUserCard({
  channel,
  owner,
}: {
  channel: Channel;
  owner: boolean;
}) {
  const q = useApiQuery(["channel", channel.id, "redis-user"], () =>
    api.channelRedisUser(channel.id),
  );
  const act = useAction();
  const [password, setPassword] = useState<string | null>(null);
  const [notPersisted, setNotPersisted] = useState(false);

  const issue = async () => {
    // Clear first: a failed re-issue must not leave the *previous* password on
    // screen next to a card that now describes a different account.
    setPassword(null);
    setNotPersisted(false);
    const r = await act.run(() => api.issueChannelRedisUser(channel.id));
    if (r) {
      setPassword(r.password ?? null);
      setNotPersisted(r.persisted === false);
      q.set({ ...r, password: undefined, issued: true, configured: true });
    }
  };
  const revoke = async () => {
    const r = await act.run(() => api.revokeChannelRedisUser(channel.id));
    if (r && q.data) {
      // The password on screen belongs to an account that no longer exists.
      setPassword(null);
      setNotPersisted(false);
      q.set({ ...q.data, issued: false });
    }
  };

  return (
    <Card withBorder mb="md">
      <Title order={4} mb="xs">
        Redis account
      </Title>
      {q.error ? (
        <Notice kind="error">{q.error}</Notice>
      ) : !q.data ? (
        <Spinner />
      ) : (
        <>
          {act.error && <Notice kind="error">{act.error}</Notice>}
          {password && (
            <SecretOnce
              label="Redis password"
              value={password}
              onDismiss={() => setPassword(null)}
            />
          )}
          <CopyField label="Host" value={q.data.host} />
          <CopyField label="Port" value={String(q.data.port)} />
          <CopyField label="Username" value={q.data.username} />
          {notPersisted && (
            <Notice kind="warn">
              The account was created but could not be written to Redis&apos;
              ACL file, so it will disappear the next time Redis restarts. Copy
              the password to keep going now, and issue again once the host is
              healthy.
            </Notice>
          )}
          <Text size="sm" c="dimmed" my="xs">
            {q.data.configured === false
              ? "This stage has no credential issuer configured, so accounts cannot be issued here yet. The prefixes above are still the ones your Lambda must use."
              : q.data.issued
                ? "Issued. The password exists only in Redis' hashed form — if it is lost, issue again (the old one stops working)."
                : "Not issued yet. Your game Lambda cannot log in until you issue one."}{" "}
            The account is scoped to this channel&apos;s prefixes above, so a
            wrong prefix fails <Code>NOPERM</Code> instead of reaching another
            game&apos;s queue.
          </Text>
          {owner && q.data.configured !== false && (
            <Group>
              <Button
                size="compact-sm"
                variant="default"
                disabled={act.busy}
                onClick={() => void issue()}
              >
                {q.data.issued ? "Re-issue" : "Issue"}
              </Button>
              {q.data.issued && (
                <Confirm
                  label="Revoke"
                  onConfirm={revoke}
                  disabled={act.busy}
                />
              )}
            </Group>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * The server credential for the state service, on the auth channel that owns
 * the document namespace. A separate card from the channel's own secret
 * because the two have different holders: the signing secret never leaves the
 * platform, this one is pasted into a participant's game server — and rotating
 * either must leave the other alone.
 */
function AuthDocKeyCard({
  channel,
  owner,
}: {
  channel: Channel;
  owner: boolean;
}) {
  const q = useApiQuery(["channel", channel.id, "doc-key"], () =>
    api.channelDocKey(channel.id),
  );
  const act = useAction();
  const [apiKey, setApiKey] = useState<string | null>(null);

  const issue = async () => {
    // Cleared first: a failed re-issue must not leave the previous key on
    // screen beside a card that now describes a different one.
    setApiKey(null);
    const r = await act.run(() => api.issueChannelDocKey(channel.id));
    if (r) {
      setApiKey(r.apiKey ?? null);
      // `documents` is not on the issue response; keeping the previous count
      // beats making it vanish from the card until the next refetch.
      q.set({
        ...r,
        apiKey: undefined,
        issued: true,
        documents: r.documents ?? q.data?.documents,
      });
    }
  };
  const revoke = async () => {
    const r = await act.run(() => api.revokeChannelDocKey(channel.id));
    if (r && q.data) {
      setApiKey(null);
      q.set({ ...q.data, issued: false });
    }
  };

  return (
    <Card withBorder mb="md">
      <Title order={4} mb="xs">
        Document storage
      </Title>
      {q.error ? (
        <Notice kind="error">{q.error}</Notice>
      ) : !q.data ? (
        <Spinner />
      ) : (
        <>
          {act.error && <Notice kind="error">{act.error}</Notice>}
          {apiKey && (
            <SecretOnce
              label="Document API key"
              value={apiKey}
              onDismiss={() => setApiKey(null)}
            />
          )}
          <CopyField label="Base URL" value={q.data.docUrl} />
          <CopyField label="Path" value={q.data.writePath} />
          <Text size="sm" c="dimmed" my="xs">
            {q.data.configured === false
              ? "This stage has no document service deployed, so a key cannot be issued here yet."
              : q.data.issued
                ? "Issued. The key is shown once — if it is lost, issue again (the old one stops working)."
                : "Not issued yet. Your game server cannot write documents until you issue one."}
            {q.data.documents !== undefined && (
              <>
                {" "}
                {q.data.documents} document
                {q.data.documents === 1 ? "" : "s"} stored.
              </>
            )}
          </Text>
          <Text size="sm" c="dimmed" my="xs">
            Your server writes with <Code>Authorization: Bearer</Code> and{" "}
            <Code>If-Match</Code> set to the version it read (<Code>0</Code> to
            create). A stale version is answered <Code>409</Code> with the
            version that won, so two results landing on one inventory cannot
            silently overwrite each other. Players read only their own document,
            with the channel JWT they already hold.
          </Text>
          {owner && q.data.configured !== false && (
            <Group>
              <Button
                size="compact-sm"
                variant="default"
                disabled={act.busy}
                onClick={() => void issue()}
              >
                {q.data.issued ? "Re-issue" : "Issue"}
              </Button>
              {q.data.issued && (
                <Confirm
                  label="Revoke"
                  onConfirm={revoke}
                  disabled={act.busy}
                />
              )}
            </Group>
          )}
        </>
      )}
    </Card>
  );
}

function QDetails({ c }: { c: Channel }) {
  const cfg = c.config as QConfig;
  const r = c.redis;
  return (
    <>
      <CopyField label="WebSocket URL" value={c.wsUrl ?? ""} />
      <CopyField label="Auth channel" value={cfg.authChannelId} />
      {r && (
        <>
          <CopyBlock
            label="tslib prefixes (copy as one block)"
            lines={[
              ["eventKeyPrefix", r.eventKeyPrefix],
              ["queueKeyPrefix", r.queueKeyPrefix],
              ["lockKeyPrefix", r.lockKeyPrefix],
              ["awaiterKeyPrefix", r.awaiterKeyPrefix],
              ["channelPrefix", r.channelPrefix],
            ]}
          />
          <CopyField label="Redis ACL key pattern" value={r.aclKeyPattern} />
          <CopyField
            label="Redis ACL channel pattern"
            value={r.aclChannelPattern}
          />
          <CopyField label="Redis username" value={r.aclUsername} />
        </>
      )}
      <Text size="sm" c="dimmed">
        Your entry API allocates the game id and writes the start event; player
        sockets then connect with <Code>?gameId=…</Code> appended to the
        WebSocket URL. Copy the <strong>prefix block above</strong> and set each
        tslib prefix option from it unchanged: the Redis account issued for this
        channel is scoped to <Code>{r?.aclKeyPattern}</Code>, so a prefix you
        invent lands outside it, and one that merely differs is a silent no-op
        rather than an error. Pass them to the prefix options directly — a
        helper that appends a segment of its own (a second <Code>queue:</Code>)
        leaves you writing to a key nobody reads.
      </Text>
    </>
  );
}

function MatchDetails({ c }: { c: Channel }) {
  const cfg = c.config as MatchConfig;
  return (
    <>
      <CopyField label="WebSocket URL" value={c.wsUrl ?? ""} />
      <CopyField label="Auth channel" value={cfg.authChannelId} />
      <CopyField label="Callback URL" value={cfg.callbackUrl} />
      <Text size="sm" c="dimmed">
        Party size {cfg.partySize} · wait {cfg.waitTimeoutSec}s · on timeout:{" "}
        {cfg.onTimeout}
      </Text>
    </>
  );
}
