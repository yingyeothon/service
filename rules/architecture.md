# Architecture

- Layout: `packages/*` (shared libs: core, upstash, sqlite-s3, jwt, http, ws, console-db), `services/{auth,console,topic,match}` (one Serverless stack each), `apps/console-web` (React+Vite SPA), `cli/` (Go), `layers/better-sqlite3`, `scripts/`, `examples/sample-dungeon` (tslib integration).
- Services depend only on `packages/*`; never import another service's `src`. Cross-service data goes through the console sqlite file (read-only from auth/topic/match) or Redis.
- The console stack is the only writer of `console.db`. auth/topic/match read channel config via `sqliteS3.read()` with a short Redis cache.
- Follow tslib API conventions (`~/git/yyt.life/tslib/CONVENTIONS.md`): `create*` factories returning interfaces, no exported classes, options object when >2 params or any optional param, no `process.env`/`console.*` inside `packages/*` (handlers read env once and pass options), `logger?: Logger`.
- Keep the JWT claim contract (`iss=yyt-auth/{channelId}`, `aud`, `sub=userId`, `exp`) identical to `docs/auth-game-contract.md` so tslib's `createJwtRequestAuthorizer` verifies our tokens unchanged.
- Never add new persistence technologies (DynamoDB, RDS) — the decision is sqlite-on-S3 + Upstash. Reopen `docs/decisions.md` if that proves insufficient.
- Do not port legacy repos' build layers (node8–14, webpack); only port algorithms (`lobby-api/src/match`) with fresh tests.
