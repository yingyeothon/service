import {
  Anchor,
  Button,
  Group,
  NativeSelect,
  Stack,
  Title,
} from "@mantine/core";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api";
import { ChannelForm } from "../components/ChannelForm";
import { Notice } from "../components/ui";
import { buildConfig, emptyForm } from "../lib/channelForm";
import { errorMessage } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";
import type { ChannelKind } from "../types";

export function ChannelNewPage() {
  const nav = useNavigate();
  const [kind, setKind] = useState<ChannelKind>("auth");
  const [form, setForm] = useState(emptyForm);
  const auths = useApiQuery(["channels", "auth", false], () =>
    api.channels({ kind: "auth" }),
  );
  const act = useAction();
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let config: unknown;
    try {
      config = buildConfig(kind, form, "create");
      setLocalError(null);
    } catch (err) {
      setLocalError(errorMessage(err));
      return;
    }
    const created = await act.run(() =>
      api.createChannel({ kind, name: form.name.trim(), config }),
    );
    if (!created) return;
    // The secret is only in this response: hand it to the detail page via
    // navigation state so it is shown once and never refetched.
    void nav(`/channels/${encodeURIComponent(created.id)}`, {
      state: { shown: created.secret ?? created.apiKey },
    });
  };

  const needsAuth = kind !== "auth" && auths.data?.length === 0;
  return (
    <>
      <Title order={2} mb="sm">
        New channel
      </Title>
      <form onSubmit={(e) => void submit(e)}>
        <Stack gap="sm" maw={560}>
          <NativeSelect
            label="Kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ChannelKind)}
            data={[
              {
                value: "auth",
                label: "auth — issues JWTs to players (GitHub/Google login)",
              },
              {
                value: "topic",
                label: "topic — broadcast topics over WebSocket",
              },
              { value: "match", label: "match — WebSocket matchmaker" },
            ]}
          />
          {needsAuth && (
            <Notice kind="warn">
              topic/match channels need an auth channel you own.{" "}
              <Anchor component={Link} to="/channels/new">
                Create an auth channel
              </Anchor>{" "}
              first.
            </Notice>
          )}
          <ChannelForm
            kind={kind}
            form={form}
            onChange={setForm}
            authChannels={auths.data ?? []}
          />
          {(localError ?? act.error) && (
            <Notice kind="error">{localError ?? act.error}</Notice>
          )}
          <Group>
            <Button type="submit" disabled={act.busy || needsAuth}>
              Create
            </Button>
            <Button component={Link} to="/channels" variant="default">
              Cancel
            </Button>
          </Group>
        </Stack>
      </form>
    </>
  );
}
