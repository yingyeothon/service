# Binary catalog: legacy absorption record and artifact tag contract

Decisions: `docs/decisions.md` _Binary catalog (console)_ and _Teams and projects_. This file records what the 2026-08-24 absorption of the standalone catalog platform (Go Lambda API + admin web + `cata` CLI + Android installer) settled, so that later work does not re-derive it. Operational identifiers of the retired stack live outside this repo.

## What was carried over, what was dropped

| Legacy                                                | Now                                                                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Own GitHub OAuth app, cookie JWT, `cata_` API keys    | Console session + `yyt_` API tokens; GitHub **device flow** on console mints a `yyt_` token for CLIs                                                                        |
| SQLite-on-S3 + external HTTP Redis (dev/prod shared!) | Console MySQL (Prisma) + self-hosted Redis under `console:{stage}:` (device-flow handles, sessions/OAuth state, ACL account state, rate limits; upload tracking is DB rows) |
| S3-event finalizer for uploads                        | Explicit `POST /catalog/uploads/{id}/commit` (HeadObject → row claim → CopyObject to final key → staging delete, idempotent)                                                |
| Separate `garbage`/`cleanup` Lambdas                  | Folded into console's daily `expire` sweep (`runCatalogSweep`: expired pending rows → orphan `uploads/` (24 h grace) → retention)                                           |
| Own API domains                                       | Retired; everything on the console domain                                                                                                                                   |
| Installer applicationId (vendor id)                   | New id + new signing key, no compatibility (users reinstall)                                                                                                                |
| `cata` CLI                                            | `yyt catalog …` (`yyt cata` alias); `cli/README.md` has the command map                                                                                                     |
| App/group permission model                            | Withdrawn 2026-08-26 — team membership only (groups dropped)                                                                                                                |

Legacy data existed only for the dev stage; it was imported once into the dev console (the import script was deleted with the 2026-08-27 contract migration). Prod started as an empty catalog; pre-existing prod objects keep their manual keys and public CDN URLs.

Not ported on purpose: inline settings flags on `deploy` (use `catalog app settings`), typed upload flags for every platform (only `android`/`ios` are typed; the rest use `--tag k=v`), `upload-status` polling (commit is synchronous), `health` (console has no route), `admin apps/groups` (admin sees everything in the normal list).

## Artifact tag contract (server allowlist)

`services/console/src/catalog.ts` validates tags on upload/commit. Unknown keys are rejected, so deploy scripts must stay inside this set.

- Common: `version`, `stage`, `build`, `commit`, `changelog`, `package_type`, `title`
- `android`: `application_id`, `build_type`, `min_sdk`, `target_sdk`, `abi`
- `ios`: `bundle_id`, `build_number`, `distribution_method`, `minimum_os_version` — `ad-hoc` requires `bundle_id` + `build_number` and makes the server publish an OTA `manifest.plist` (`ios.manifestUrl` / `ios.installUrl` in the response)
- `web`: `entrypoint`, `mount_path`, `spa_fallback`
- `bin`: `content_type`, `sha256`, `filename`
- `server`: `content_type`, `sha256`, `filename`, `entrypoint`, `type`
- `win32` / `osx` / `linux`: `arch`, `sha256`, `filename`, `entrypoint`

Artifact listing filters server-side by `platform`/`limit` only; `yyt catalog artifact list --filter k=v` filters client-side (lists are small).

## Upload limits

Commit performs a synchronous `CopyObject` inside the request Lambda: 1 GB artifact cap, 25 s function timeout (API Gateway allows ~29 s). Larger artifacts need an async commit design, not a bigger cap. Slack notification on commit is best-effort with a 3 s timeout; the hook URL is stored in the DB, host-pinned to `hooks.slack.com`, and never echoed to non-owners.

## Console SPA port (2026-08-24)

The SPA was re-based on Mantine 8 + TanStack Query (decision in `docs/decisions.md`). Constraints that the port had to keep and that still bind any redesign: `/ui/` base path (`__Host-` cookie needs the API host), `credentials: "same-origin"` + Origin CSRF on mutations, one-time secrets passed via router state and scrubbed with `history.replaceState`, same-origin poster `<img>` with `?v=updatedAt`, `role="alert"/"status"` + `aria-live`, two-click confirm for destructive actions, and the Vite dev proxy's Origin rewrite / `x-debug-key` injection.
