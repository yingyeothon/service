import {
  Anchor,
  Button,
  Group,
  NativeSelect,
  Paper,
  Stack,
} from "@mantine/core";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { ChannelForm } from "../components/ChannelForm";
import { Crumbs } from "../components/Crumbs";
import { PageSkeleton } from "../components/Loading";
import { PageHeader } from "../components/PageHeader";
import { ReadOnlyBanner } from "../components/ReadOnlyBanner";
import { Notice } from "../components/ui";
import { buildConfig, emptyForm } from "../lib/channelForm";
import { errorMessage } from "../lib/format";
import { notify } from "../lib/notify";
import { useAction, useApiQuery } from "../lib/query";
import { projectUrl, useTeamStanding } from "../lib/team";
import type { ChannelKind } from "../types";

/**
 * The console's one form page: a channel's create form is kind-switched and
 * long, and its success navigates away carrying the once-shown secret, so a
 * drawer would only be a scrolling modal. Channels are created inside a
 * project; topic/match/lobby/q link an auth channel of the same project.
 */
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
    notify.created("channel");
    // The secret is only in this response: hand it to the detail page via
    // navigation state so it is shown once and never refetched.
    void nav(`/channels/${encodeURIComponent(created.id)}`, {
      state: { shown: created.secret ?? created.apiKey },
    });
  };

  const crumbs = (
    <Crumbs
      crumbs={{
        teamId: project.data?.teamId ?? teamId,
        teamName: project.data?.teamName ?? null,
        projectId: project.data?.id ?? prj,
        projectName: project.data?.name ?? null,
      }}
      current="New channel"
    />
  );
  if (project.error)
    return (
      <>
        {crumbs}
        <PageHeader title="New channel" />
        <Notice kind="error">{project.error}</Notice>
      </>
    );
  if (!project.data)
    return (
      <>
        {crumbs}
        <PageHeader title="New channel" />
        <PageSkeleton />
      </>
    );
  const back = projectUrl(teamId, prj, "channels");
  const needsAuth = kind !== "auth" && auths.data?.length === 0;
  return (
    <>
      {crumbs}
      <PageHeader
        title="New channel"
        description="An auth channel issues player tokens; topic, match, lobby and q channels hang off one. The secret is shown once, on the next page."
      />
      {!standing.canWrite && !standing.loading && (
        <ReadOnlyBanner detail="Creating a channel reveals its secret, so it takes a seat in this project’s team (platform admins are refused)." />
      )}
      <Paper withBorder p="lg" maw={640}>
        <form onSubmit={(e) => void submit(e)}>
          <Stack gap="md">
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
                topic/match/lobby/q channels need an auth channel in this
                project.{" "}
                <Anchor
                  component="button"
                  type="button"
                  onClick={() => setKind("auth")}
                >
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
            <Group justify="flex-end" gap="xs">
              <Button component={Link} to={back} variant="default">
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={act.busy || needsAuth || !standing.canWrite}
                loading={act.busy}
              >
                Create channel
              </Button>
            </Group>
          </Stack>
        </form>
      </Paper>
    </>
  );
}
