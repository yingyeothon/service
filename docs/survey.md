# Prior-art survey (2026-08-22)

## tslib (`~/git/yyt.life/tslib`)

- pnpm monorepo, Node ≥ 20 ESM, tsup dual build, vitest (80/70 coverage enforced), ESLint 9 + prettier, OIDC npm publish. `CLAUDE.md` (= `AGENTS.md` symlink) + `CONVENTIONS.md` + `rules/`.
- Conventions: no exported classes (`create*` factories), options objects, no `process.env`/`console` in libraries, `logger?: Logger`.
- Touch points: `lambda-authorizer-jwt.createJwtRequestAuthorizer` (sub → memberId, `bearer` subprotocol), `lambda-gamebase.handleConnect` (`resolveMemberId`, `selectSubprotocol`), `readyCall(callbackUrl)`, `GameActorStartEvent`, `Transport{send,drop}`. Redis via `naive-redis` (raw TCP). No matchmaker or dungeon.

## Legacy yyt.life stacks

- Reused: `lobby-api/src/match` (FIFO matching + jest), `message-topic-broadcast/serverless.ts` (WS authorizer config), `ydeploy` (cookie authorizer, console skeleton), `binary-distribution-api2` (SLS4 + esbuild + node20 baseline).
- Dropped: `message-topic`, `message-broadcast` (node8), `management-console-web` (snowpack), `yyt-28-server` (EC2), build layers of `auth-api`/`lobby-api` (node12).
- Lesson: legacy stacks shared one copied `JWT_SECRET_KEY`; this repo uses per-channel secrets.

## secret_vote (`~/git/dooroo/secret_vote/server-serverless`)

- Go + sqlite, single S3 file, Upstash REST, lock `SET NX EX 60` + 100 ms × 50 retries + Lua compare-and-delete. Its lock key lacked a stage prefix — do not repeat. `rules/` layout borrowed from there.
