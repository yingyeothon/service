import type { PrismaClient } from "./generated/prisma/client.js";

/**
 * Invariants the team/project contract migration (`NOT NULL`, team-scoped
 * unique names, catalog permission drops — the `-- contract` file) needs
 * before it can be applied. Returns one line per violation; empty means the
 * stage is ready. Shared by `scripts/apply-team-project-map.mjs` (verify after
 * apply) and `scripts/contract-preflight.mjs` (run by `migrate.sh` before a
 * contract migration), so both judge the database by the same rules.
 */
export async function contractPreflight(
  prisma: PrismaClient,
): Promise<string[]> {
  const problems: string[] = [];
  // Raw SQL: the generated client models the post-contract schema, where
  // these columns cannot be null, but the pre-flight runs *before* it.
  const [unmapped] = await prisma.$queryRaw<
    { catalog_apps: bigint; asset_bundles: bigint; channels: bigint }[]
  >`select
      (select count(*) from catalog_apps where team_id is null or project_id is null) as catalog_apps,
      (select count(*) from asset_bundles where team_id is null or project_id is null) as asset_bundles,
      (select count(*) from channels where team_id is null or project_id is null) as channels`;
  for (const [table, n] of Object.entries(unmapped ?? {}))
    if (Number(n) > 0)
      problems.push(`${table}: ${Number(n)} row(s) without team/project`);

  // Soft-deleted channels count too: the contract's unique index does not
  // filter on deleted_at (rules/data.md).
  const dupes = await prisma.$queryRaw<
    { team_id: string; name: string; n: bigint }[]
  >`select team_id, name, count(*) as n from (
       select team_id, name from catalog_apps union all
       select team_id, name from asset_bundles union all
       select team_id, name from channels) t
     where team_id is not null group by team_id, name having n > 1
     order by team_id, name`;
  for (const d of dupes)
    problems.push(
      `team ${d.team_id}: name "${d.name}" used by ${Number(d.n)} resources`,
    );

  const reserved = await prisma.catalog_apps.count({ where: { name: "apps" } });
  if (reserved > 0)
    problems.push(`catalog_apps: ${reserved} app(s) named "apps" (reserved)`);
  return problems;
}
