import { Anchor, Breadcrumbs, Text } from "@mantine/core";
import { Link } from "react-router";
import { projectUrl, teamUrl } from "../lib/team";
import type { ResourceCrumbs } from "../types";

/**
 * `Teams › team › project › current`. Resource views carry the names, so no
 * extra request is needed; a legacy row with no team falls back to the
 * cross-team list it is still reachable from.
 */
export function Crumbs({
  crumbs,
  current,
  fallback,
}: {
  crumbs: Partial<ResourceCrumbs>;
  current?: string;
  fallback?: { label: string; to: string };
}) {
  const items: React.ReactNode[] = [];
  if (crumbs.teamId) {
    items.push(
      <Anchor component={Link} to="/teams" size="sm" key="teams">
        Teams
      </Anchor>,
      <Anchor component={Link} to={teamUrl(crumbs.teamId)} size="sm" key="team">
        {crumbs.teamName ?? crumbs.teamId}
      </Anchor>,
    );
    if (crumbs.projectId)
      items.push(
        <Anchor
          component={Link}
          to={projectUrl(crumbs.teamId, crumbs.projectId)}
          size="sm"
          key="project"
        >
          {crumbs.projectName ?? crumbs.projectId}
        </Anchor>,
      );
  } else if (fallback) {
    items.push(
      <Anchor component={Link} to={fallback.to} size="sm" key="fallback">
        {fallback.label}
      </Anchor>,
    );
  }
  if (current !== undefined)
    items.push(
      <Text size="sm" key="current">
        {current}
      </Text>,
    );
  return (
    <Breadcrumbs mb="xs" separator="›" aria-label="Breadcrumb">
      {items}
    </Breadcrumbs>
  );
}
