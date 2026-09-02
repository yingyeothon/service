import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG_PLATFORMS } from "../src/catalog.js";
import { CHANNEL_KINDS, MEMBER_ROLES } from "../src/channels.js";
import { EVENT_STATUSES } from "../src/events.js";
import { SITE_DEPLOY_STATUSES } from "../src/sites.js";
import { ISSUE_STATUSES, TEAM_ROLES } from "../src/team.js";

/*
 * `ENUM` columns order by declaration, and the fakes rank them through these
 * arrays (`enumRank`), so each array must be the schema's declaration order.
 */
const schema = readFileSync(
  new URL("../prisma/schema.prisma", import.meta.url),
  "utf8",
);
const enumValues = (name: string): string[] => {
  const m = schema.match(new RegExp(`enum ${name} \\{([^}]*)\\}`));
  if (!m) throw new Error(`enum ${name} not in schema`);
  return m[1]!
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
};

describe("enum arrays follow the schema declaration order", () => {
  it.each([
    ["team_members_role", TEAM_ROLES],
    ["issues_status", ISSUE_STATUSES],
    ["events_status", EVENT_STATUSES],
    ["site_deploys_status", SITE_DEPLOY_STATUSES],
    ["catalog_artifacts_platform", CATALOG_PLATFORMS],
    ["members_role", MEMBER_ROLES],
    ["channels_kind", CHANNEL_KINDS],
  ] as const)("%s", (name, values) => {
    expect([...values]).toEqual(enumValues(name));
  });
});
