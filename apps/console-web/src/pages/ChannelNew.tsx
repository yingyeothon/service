import { Anchor, Box, Button, Group, NativeSelect, Stack } from "@mantine/core";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import {
  ChannelForm,
  type ChannelFieldErrors,
} from "../components/ChannelForm";
import { Crumbs } from "../components/Crumbs";
import { PageSkeleton } from "../components/Loading";
import { PageHeader } from "../components/PageHeader";
import { ReadOnlyBanner } from "../components/ReadOnlyBanner";
import { Notice } from "../components/ui";
import { buildConfig, emptyForm } from "../lib/channelForm";
import { errorMessage } from "../lib/format";
import { notify } from "../lib/notify";
import {
  packageNameProblem,
  pushProblem,
  serviceAccountProblem,
  type PushProblem,
} from "../lib/push";
import { useAction, useApiQuery } from "../lib/query";
import { projectUrl, teamUrl, useTeamStanding } from "../lib/team";
import type { ChannelKind } from "../types";

/**
 * The console's one form page: a channel's create form is kind-switched and
 * long, and its success navigates away carrying the once-shown secret, so a
 * drawer would only be a scrolling modal. Channels are created inside a
 * project; topic/match/lobby/q/push link an auth channel of the same project.
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
  // A push refusal that is not one field's: the cap, or a platform condition.
  const [refusal, setRefusal] = useState<PushProblem | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ChannelFieldErrors>({});

  // A refusal belongs to the kind it was given for.
  const pickKind = (k: ChannelKind) => {
    setKind(k);
    setRefusal(null);
    setFieldErrors({});
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setRefusal(null);
    setFieldErrors({});
    if (kind === "push") {
      // The same grammar the server applies, reported under the field.
      const errors: ChannelFieldErrors = {
        packageName: packageNameProblem(form.packageName.trim()),
        serviceAccount:
          form.pushSender === "team"
            ? serviceAccountProblem(form.teamServiceAccount)
            : null,
      };
      if (errors.packageName || errors.serviceAccount) {
        setLocalError(null);
        act.clear();
        setFieldErrors(errors);
        return;
      }
    }
    let config: unknown;
    try {
      config = buildConfig(kind, form, "create");
      setLocalError(null);
    } catch (err) {
      setLocalError(errorMessage(err));
      return;
    }
    const created = await act.run(async () => {
      try {
        return await api.createChannel(prj, {
          kind,
          name: form.name.trim(),
          config,
        });
      } catch (err) {
        if (kind !== "push") throw err;
        // A refusal goes where it can be acted on: under its field, or as a
        // notice that says whose condition it is.
        const p = pushProblem(err, "create");
        if (p.at === "form") throw err;
        if (p.at === "packageName") setFieldErrors({ packageName: p.message });
        else if (p.at === "serviceAccount")
          setFieldErrors({ serviceAccount: p.message });
        else setRefusal(p);
        return undefined;
      }
    });
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
        description="An auth channel issues player tokens; topic, match, lobby, q and push channels hang off one. The secret is shown once, on the next page."
      />
      {!standing.canWrite && !standing.loading && (
        <ReadOnlyBanner detail="Creating a channel reveals its secret, so it takes a seat in this project’s team (platform admins are refused)." />
      )}
      <Box maw={640}>
        <form onSubmit={(e) => void submit(e)}>
          <Stack gap="md">
            <NativeSelect
              label="Kind"
              value={kind}
              onChange={(e) => pickKind(e.target.value as ChannelKind)}
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
                {
                  value: "push",
                  label: "push — Android push notifications (FCM)",
                },
              ]}
            />
            {needsAuth && (
              <Notice kind="warn">
                topic/match/lobby/q/push channels need an auth channel in this
                project.{" "}
                <Anchor
                  component="button"
                  type="button"
                  onClick={() => pickKind("auth")}
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
              errors={fieldErrors}
            />
            {(localError ?? act.error) && (
              <Notice kind="error">{localError ?? act.error}</Notice>
            )}
            {refusal?.at === "limit" && (
              <Notice kind="error">
                {refusal.message} A team member can ask a platform admin for one
                more under{" "}
                <Anchor
                  component={Link}
                  to={teamUrl(project.data.teamId, "projects")}
                >
                  Limits on the team page
                </Anchor>{" "}
                (Request increase). A team-sender channel does not count.
              </Notice>
            )}
            {refusal?.at === "platform" && (
              <Notice kind="error">{refusal.message}</Notice>
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
      </Box>
    </>
  );
}
