import {
  Anchor,
  Button,
  Group,
  NativeSelect,
  Stack,
  Title,
} from "@mantine/core";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { ChannelForm } from "../components/ChannelForm";
import { Crumbs } from "../components/Crumbs";
import { Notice, Spinner } from "../components/ui";
import { buildConfig, emptyForm } from "../lib/channelForm";
import { errorMessage } from "../lib/format";
import { useAction, useApiQuery } from "../lib/query";
import { projectUrl, useTeamStanding } from "../lib/team";
import type { ChannelKind } from "../types";

/** Channels are created inside a project; topic/match/lobby/q link an auth channel of the same project. */
export function ChannelNewPage() {
  const { team: teamId = "", prj = "" } = useParams();
  const nav = useNavigate();
  const project = useApiQuery(["project", prj], () => api.project(prj));
  const standing = useTeamStanding(project.data?.teamId);
  const [kind, setKind] = useState<ChannelKind>("auth");
  const [form, setForm] = useState(emptyForm);
  const auths = useApiQuery(["project", prj, "channels", "auth"], () =>
    api.projectChannels(prj, "auth"),
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
      api.createChannel(prj, { kind, name: form.name.trim(), config }),
    );
    if (!created) return;
    // The secret is only in this response: hand it to the detail page via
    // navigation state so it is shown once and never refetched.
    void nav(`/channels/${encodeURIComponent(created.id)}`, {
      state: { shown: created.secret ?? created.apiKey },
    });
  };

  if (project.error) return <Notice kind="error">{project.error}</Notice>;
  if (!project.data) return <Spinner />;
  const back = projectUrl(teamId, prj, "channels");
  const needsAuth = kind !== "auth" && auths.data?.length === 0;
  return (
    <>
      <Crumbs
        crumbs={{
          teamId: project.data.teamId,
          teamName: project.data.teamName,
          projectId: project.data.id,
          projectName: project.data.name,
        }}
        current="New channel"
      />
      <Title order={2} mb="sm">
        New channel
      </Title>
      {!standing.canWrite && !standing.loading && (
        <Notice>
          Read-only: creating a channel reveals its secret, so it takes a seat
          in this project&rsquo;s team (platform admins are refused).
        </Notice>
      )}
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
              {
                value: "lobby",
                label: "lobby — realtime relay: movement, chat, party",
              },
              {
                value: "q",
                label: "q — bridges player sockets to your game Lambda",
              },
            ]}
          />
          {needsAuth && (
            <Notice kind="warn">
              topic/match/lobby/q channels need an auth channel in this project.{" "}
              <Anchor component="button" onClick={() => setKind("auth")}>
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
            <Button
              type="submit"
              disabled={act.busy || needsAuth || !standing.canWrite}
            >
              Create
            </Button>
            <Button component={Link} to={back} variant="default">
              Cancel
            </Button>
          </Group>
        </Stack>
      </form>
    </>
  );
}
