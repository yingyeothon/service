# Team → Project → Resource: API, authorization, migration

Design decisions live in `docs/decisions.md` (_Teams and projects_). This document records the
implemented shape (2026-08-26/27) that the decisions do not spell out: the route table, how
authorization is implemented, and the migration/rollout procedure. Client-side detail:
`cli/README.md` (context resolution, command tree) and `apps/console-web/README.md` (routes).

## Routes (console)

Paths carry ids only; clients resolve names within the caller's team. Standing is the caller's
seat in the team (`pending | member | owner`) or platform `admin`.

```
GET    /teams                         member+   my seats and pending requests; admin: ?scope=all
POST   /teams                         member+   {name, description?} → caller becomes owner
POST   /teams/join                    member+   {name} → pending (unknown name = 404, not revealed)
GET|PATCH|DELETE /teams/{team}        member / owner / owner|admin (409 while projects exist)
PUT    /teams/{team}/admin-lock       admin     requires every seated row to be a platform admin
GET    /teams/{team}/members          team member
POST   /teams/{team}/members          owner     {login, role} — login must already be a platform member
PATCH  /teams/{team}/members/{mid}    owner {role}; seatless admin only {role:"owner"} for any existing platform member (self included; `pending` login → 404)
DELETE /teams/{team}/members/{mid}    owner (kick) / self (leave, or withdraw a pending request)
GET    /teams/{team}/history          team member  ?cursor&limit (cursor = (at, id))
GET|POST /teams/{team}/discussions ; GET|PATCH|DELETE …/{id} ; POST …/{id}/comments ; PATCH|DELETE …/comments/{cid}
GET|POST /teams/{team}/projects
GET    /teams/{team}/catalog/apps[?artifacts=summary&platform=]   every app of the team + projectId (permanent)
GET    /teams/{team}/issues?status=&limit=                        recent issues across the team's projects
GET|PATCH|DELETE /projects/{prj}      member / member / owner|admin (409 while resources exist, soft-deleted channels count)
GET|POST /projects/{prj}/versions ; POST …/versions/bump {part} ; GET|PATCH|DELETE …/versions/{ver}
GET|POST …/versions/{ver}/links ; DELETE …/links/{id}
GET|POST /projects/{prj}/issues ; GET|PATCH …/issues/{n} ; POST …/issues/{n}/close|reopen ; comments as above
POST|GET /projects/{prj}/channels | /projects/{prj}/catalog/apps | /projects/{prj}/assets/bundles
GET|PUT  /admin/settings/installer-app   admin
```

Single-resource routes stay id-based and unchanged in path: `/channels/{id}`, `/catalog/apps/{appId}`,
`/assets/bundles/{bundleId}` (plus their sub-routes: settings, extend, rotate-secret, redis-user, doc-key, artifacts, artifacts/cleanup; gateway lookups are top-level `GET /gw/health`, `GET /gw/channels/{id}`).
`GET /channels` lists every channel across the caller's teams (`?scope=all` for admin).

Resource views carry `teamId, teamName, projectId, projectName, createdBy` (login) for breadcrumbs;
`ownerId`, `ownerLogin`, `pending*` and `permissions` are gone. Version list/detail views carry
`artifactCount`/`assetCount`, derived from live `project_version_links` (never stored).

Compatibility routes for the installed installer, kept for one release and removed once every installed installer has moved (`rules/deployment.md`):
`GET /catalog/apps` (flattened over the caller's teams), `GET /catalog/apps/{id|name}/artifacts*`
(name resolves only when unique in the caller's teams). `GET /catalog/installer/downloads` is permanent
and serves `platform_settings.installer_app_id`; with no installer app configured it answers `200 {downloads: []}`,
and `503` (`details.reason: installer_untrusted`) when the configured app's team is not `admin_locked`.

## Authorization implementation

- `services/console/src/team-access.ts` is the only place that decides team access:
  `teamAccess(ctx, teamId)` → standing; `projectAccess`; `projectResource(ctx, {kind, id}, {secret?})`
  resolves resource → project → team in two hops. `secret: true` (channel config/secret, rotate,
  redis-user, doc-key, catalog settings incl. Slack hook) refuses admins with 403; a non-member gets 404.
- Every former owner check was replaced: `ownedChannel`, `appAccess`, `bundleWith` are gone; `qChannel`, `appWith`,
  `uploadWith`, `requireAuthChannel` and the state doc-key check survive only as wrappers over `projectResource`. Acceptance test:
  `grep -n "ownerId ===\|ownerId !==" services/console/src` is empty outside views/audit, and a creator
  kicked from the team gets 404 on GET/PATCH/rotate/redis-user/doc-key/commit.
- Writes that must be recorded go through `@yyt/console-db` `TeamDb` in one `$transaction` that locks the
  team row first and inserts `team_history` (field names only, never values). Resource create/delete
  and the daily expire write history best-effort after the resource write, plus the global audit log.
- Kick/leave responses list the channels whose credentials the departed member still knows; nothing is
  revoked automatically.

## Migration and rollout

Order per stage (the expand/contract split is explained in `docs/decisions.md` and `rules/data.md`):

1. `scripts/migrate.sh <stage>` — expand `6_org_project` (+ `7_team_rename`).
2. `node scripts/apply-team-project-map.mjs <stage> local/team-project-map.<stage>.json [--execute]`
   — dry-run by default; refuses while any existing resource is unmapped; creates teams/projects,
   assigns rows, deletes listed rows (artifacts and their S3 objects included; channels are hard-deleted
   because a soft-deleted row blocks the contract's `NOT NULL`), writes `platform_settings`, then verifies.
3. `node scripts/split-projects-per-app.mjs <stage> local/split-projects.<stage>.json [--execute]`
   — one project per app (optionally merging names), version backfill from artifact `tags.version`
   (semver with `+build` stripped) and links; without `from` it still moves apps to their declared project (never deletes) and backfills versions.
4. `scripts/deploy.sh console <stage>` → `scripts/deploy.sh auth <stage>` (auth bundles the same Prisma
   client) → SPA (`scripts/deploy-web.sh <stage>`) → CLI tag/release → installer publish.
5. Contract `m0008_team_project_contract`, only once every stage runs the new bundle: dump first, then
   `scripts/migrate.sh <stage> deploy --allow-contract` by hand (`scripts/contract-preflight.mjs` gates it).

Rollback: before the contract, redeploy the previous bundle (it ignores the new tables/columns); after the
contract, only a dump restore. Between expand and contract the old global unique names still apply, so
the same name in two teams answers `409 "duplicate key"` (global unique) and, inside one team, the app-level guard's 409.

Prod acceptance has no debug hooks, so it is a CLI round trip (`yyt team ls`, `catalog app get`,
`project version ls`, `artifact upload/list`) instead of the smoke scripts.

The dev/prod inventories, mapping files, dump timestamps and generated ids are machine-local
(`local/team-project-map.<stage>.json`, `local/split-projects.<stage>.json`, `local/ops-notes.md`).
