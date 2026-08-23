import {
  Anchor,
  Button,
  Card,
  Code,
  Group,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { ChannelForm } from "../components/ChannelForm";
import {
  Badge,
  Confirm,
  CopyField,
  Notice,
  SecretOnce,
  Spinner,
} from "../components/ui";
import { buildConfig, emptyForm, formFromChannel } from "../lib/channelForm";
import { errorMessage, fmtRelative, fmtTime } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";
import type { AuthConfig, Channel, MatchConfig, TopicConfig } from "../types";

export function ChannelDetailPage() {
  const { id = "" } = useParams();
  const { me } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const ch = useApiQuery(["channel", id], () => api.channel(id));
  const auths = useApiQuery(["channels", "auth", false], () =>
    api.channels({ kind: "auth" }),
  );
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
  const owner = c.ownerId === me?.id;
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
    if (ok) void nav("/channels");
  };

  return (
    <>
      <Text size="sm" mb="xs">
        <Anchor component={Link} to="/channels">
          ← Channels
        </Anchor>
      </Text>
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
      {!owner && (
        <Notice>
          Owned by another member; admins can extend or delete but not edit or
          rotate.
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
        {c.kind === "auth" && <AuthDetails c={c} />}
        {c.kind === "topic" && <TopicDetails c={c} />}
        {c.kind === "match" && <MatchDetails c={c} />}
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
          {owner && (
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
