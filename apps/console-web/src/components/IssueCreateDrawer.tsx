import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api } from "../api";
import { notify } from "../lib/notify";
import { useAction } from "../lib/query";
import { issueUrl } from "../lib/team";
import type { Version } from "../types";
import { DiscussionFields, VersionSelect } from "./IssueFields";
import { ResourceDrawer, type useDrawerForm } from "./ResourceDrawer";

export interface IssueDraft {
  title: string;
  bodyMd: string;
  versionId: string | null;
}

/** The empty draft, optionally against one version (the version page). */
export const newIssueDraft = (versionId: string | null = null): IssueDraft => ({
  title: "",
  bodyMd: "",
  versionId,
});

/**
 * The one "New issue" drawer, shared by the project's Issues tab and the
 * version page (`todo/52`). The page owns the drawer state (`useDrawerForm`)
 * so `open()` keeps reseeding the draft; on success every issue list of the
 * project is invalidated (the tab's and the version page's keys both start
 * with `["issues", projectId]`) and the new issue's page opens.
 */
export function IssueCreateDrawer({
  projectId,
  teamId,
  versions,
  state,
}: {
  projectId: string;
  teamId: string;
  versions: Version[];
  state: ReturnType<typeof useDrawerForm<IssueDraft>>;
}) {
  const act = useAction();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  // A failed submit's error would otherwise greet the next open.
  const wasOpen = useRef(false);
  const clear = act.clear;
  useEffect(() => {
    if (state.opened && !wasOpen.current) clear();
    wasOpen.current = state.opened;
  }, [state.opened, clear]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() =>
      api.createIssue(projectId, {
        title: state.form.title.trim(),
        bodyMd: state.form.bodyMd,
        versionId: state.form.versionId,
      }),
    );
    if (!r) return;
    void queryClient.invalidateQueries({ queryKey: ["issues", projectId] });
    state.close();
    notify.created("issue");
    void nav(issueUrl(teamId, projectId, r.number));
  };
  return (
    <ResourceDrawer
      opened={state.opened}
      onClose={state.close}
      title="New issue"
      submitLabel="Open issue"
      onSubmit={submit}
      busy={act.busy}
      disabled={!state.form.title.trim()}
      error={state.opened ? act.error : null}
      size="lg"
    >
      <DiscussionFields
        title={state.form.title}
        bodyMd={state.form.bodyMd}
        onChange={(p) => state.patch(p)}
        bodyLabel="Description"
        extra={
          <VersionSelect
            versions={versions}
            value={state.form.versionId}
            onChange={(versionId) => state.patch({ versionId })}
          />
        }
      />
    </ResourceDrawer>
  );
}
