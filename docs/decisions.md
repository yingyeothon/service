# Decisions (confirmed 2026-08-22)

Single source of truth for settled product/technical decisions. Change this file first, then the code.

## Purpose

- Shared contest-support services with near-zero traffic outside hackathon day.
- Goal: with tslib (`@yingyeothon/*`) plus these services, a team builds a casual MORPG (lobby HTTP API / party matching / instant dungeon) within a 7-hour contest, spending **2–3 hours on the server**.
- Therefore auth, matchmaking, and broadcast are pre-built services the game only calls.

## Stack

| Area          | Decision                                                                                                                                                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server        | TypeScript, Node 22 (`nodejs22.x`, arm64), ESM, Serverless Framework 4 + `serverless-esbuild`                                                                                                                                                                                          |
| CLI           | Go single binary, goreleaser → GitHub Release (linux/mac/win)                                                                                                                                                                                                                          |
| Repo          | pnpm monorepo: `packages/*` shared libs, `services/*` stacks (console / auth / topic / match), `apps/console-web` SPA, `cli/`                                                                                                                                                          |
| DB            | Self-hosted MariaDB (host/accounts only in the private ops repo `yyt-stateful`). One database per stage, owned by console (schema, migrations, writes). auth/topic/match use `SELECT`-only accounts to read channel config. One account per service × stage. sqlite-on-S3 was dropped. |
| Runtime state | Volatile state (topic connections, match pool/tickets, sessions) lives **only in Redis**.                                                                                                                                                                                              |
| Redis         | Self-hosted Redis over `ioredis` TCP (`@yyt/redis`). One ACL user per service × stage restricted to `{service}:{stage}:*`; same value as the key prefix. One connection per Lambda container; every key has a TTL. Upstash REST was dropped.                                           |
| Infra         | Region `ap-northeast-2`, `AWS_PROFILE=yyt`, stages `dev`/`prod`, domains `{console,auth,topic,match}.yyt.life` plus `topic-ws.yyt.life` for the topic WebSocket (`serverless-domain-manager`), SPA on S3 + CloudFront                                                                  |
| Secrets       | Only in gitignored `local/env/{service}.{stage}.env`, uploaded by `scripts/bootstrap-ssm.sh` to SSM `/yyt-service/{stage}/{service}/*`, restored by `scripts/get-env.sh`; `serverless.yml` reads `${ssm:...}`. Policy: `docs/secrets.md`.                                              |
| Tests         | vitest. Redis/MySQL behind interfaces with in-memory fakes (`createMemoryKv`, `createMemoryConsoleDb`); drivers mocked. Integration tests against dev instances only with `YYT_IT=1` + `local/env/*.dev.env`. No Docker. Manual verification = dev deploy + `curl`/`wscat` smoke.      |
| Commit/push   | Three adversarial reviews, then commit directly to `main` and push to `yingyeothon/service`.                                                                                                                                                                                           |

## Console permission model

- Login: **GitHub OAuth only**. Session = httpOnly cookie (SPA) or Bearer API token (CLI).
- Roles `admin` / `member` / `pending`. New sign-ups are `pending` until an admin approves.
- Bootstrap admins: GitHub logins listed in `ADMIN_GITHUB_LOGINS` (comma-separated) become `admin` on their **first** login only (GitHub logins can be re-registered; later changes go through `/members/{id}/promote`).
- Channels (auth/topic/match) belong to their creator (`member`+). Admins can view/extend/delete any channel but never read or change its secrets/config (PATCH, rotate-secret are owner-only). topic/match channels must reference an auth channel the caller owns.
- Channel expiry: 7 days, extendable by 7 (cap now+28). Expired → disabled (401/410) by the daily sweep; extending a disabled channel revives it; deleted (secrets wiped) 30 days after being disabled.
- Secrets are shown once on creation and can be rotated.

## auth service

- Channel = `{ channelId, secret (HS256), audience, tokenTtlSec (default 86400), providers: { github?: {clientId, clientSecret}, google?: {clientId, clientSecret} } }`.
- Users register **their own OAuth app** and set its callback to `https://auth.yyt.life/c/{channelId}/{provider}/callback`.
- JWT: HS256, `iss = yyt-auth/{channelId}`, `aud = channel.audience`, `sub = userId`, `exp = iat + tokenTtlSec`. `userId` = first 32 hex of `sha256(channelId + ":" + provider + ":" + providerUserId)`. No PII stored or claimed.
- Routes: `GET /c/{ch}/start?provider=&redirect=` → provider → `GET /c/{ch}/{provider}/callback` → `302 {redirect}#token=…&userId=…`. Manual: `POST /c/{ch}/token {provider, accessToken|idToken}` → `{jwt, userId, exp}`. `GET /c/{ch}/verify` (Bearer) → `{userId, exp}`.
- Games verify locally with the channel secret (tslib `createJwtRequestAuthorizer`; contract in `docs/auth-game-contract.md`).
- **Debug seeding**: dev `POST /debug/channels` writes the console DB, so console's dev MySQL account is supplied separately as SSM `/yyt-service/dev/auth/debug-mysql-{user,password}` (copied by `bootstrap-ssm.sh dev`) and injected only when deployed with `--param debugHooks=1`. prod has neither the keys nor the routes. Move seeding to the console API/CLI once they exist, then remove the keys.

## topic service

- Channel (console) → `{ channelId, apiKey, authChannelId, wsUrl }`.
- `POST /t` (Bearer apiKey) `{ allowUserIds?, ttlSec? ≤ 1200 }` → `{ topicId, wsUrl, expiresAt }`. **Topic lifetime ≤ 20 min.**
- Connect: `wss://topic-ws.yyt.life/?topic={topicId}` (the `wsUrl` returned by `POST /t`; API Gateway cannot map an HTTP API and a WebSocket API onto one custom domain, so the HTTP control API lives on `topic.yyt.life` and sockets on `topic-ws.yyt.life`) + `Sec-WebSocket-Protocol: bearer, <auth JWT>`. Allowed if in `allowUserIds`, or (when empty) the JWT verifies against the linked auth channel.
- Clients send `{type:"msg", payload}` (`{type:"ping"}` → `{type:"pong"}`). Messages are wrapped as `{ type:"msg", from:userId, seq, payload }` and echoed to **everyone including the sender**; `{type:"join"|"leave", userId}` on membership changes (the joiner does not receive its own `join`). 16 KB cap (`{type:"error", code:"too_large"|"bad_message"}`). No history. `POST /t/{id}/publish {payload}` sends `from:"server"`; `GET /t/{id}` returns meta + connection count; `DELETE /t/{id}` broadcasts `{type:"closed"}` and drops every socket. An expired or deleted topic answers the next client message with `{type:"expired"}` and does not close the socket (clients close).
- State: `topic:{stage}:t:{topicId}` (meta), `:conns` (set), `:seq` (counter), `conn:{connId}` → `{topicId,userId,at}`; all with the topic's TTL.

## match service

- Channel = `{ channelId, apiKey, authChannelId, partySize (2–16), waitTimeoutSec (60), onTimeout: "partial"|"fail", callbackUrl, wsUrl }`.
- Connecting = submitting a ticket: `wss://match.yyt.life/?channel={channelId}` + `bearer, <auth JWT>`. Invalid JWT → rejected. Reconnecting with the same userId replaces the ticket; disconnect removes it.
- Algorithm: FIFO only. Every connect triggers a match attempt (run by an async worker invocation, because a socket cannot be posted to from inside its own `$connect`); disconnect only removes the ticket. An EventBridge 1-minute schedule handles timeouts and acts as the backstop (documented as "handled within ~2 min").
- Match → `POST callbackUrl` `{ matchId, channelId, members:[{userId}], partial }` with `X-Yyt-Signature: hmac-sha256(channel.apiKey, body)`. The 2xx JSON response (≤8 KB, empty body → `null`) is forwarded verbatim to each client as `{type:"matched", matchId, partial, result}`. Callback failure (network, non-2xx, non-JSON; one retry on 5xx/network) → `{type:"failed", reason:"callback"}`. The server never closes the socket after a terminal message (closing right after `PostToConnection` loses the frame); clients close, idle sockets expire.
- Reconnect with the same userId: the old socket receives `{type:"replaced"}`. `{type:"ping"}` → `{type:"pong", position, waited}`.
- Timeout: `partial` → match with whoever is present, possibly a single player (`partial:true`); `fail` → `{type:"failed", reason:"timeout"}`. A disabled/expired channel (seen within the 60s config cache) or a ping from a socket without a ticket → `{type:"failed", reason:"closed"}`.
- Callback target may be the topic service (`POST /t`) or a tslib dungeon server (creates `GameActorStartEvent`, returns `{wsUrl, gameId, token}`).

## Hackathon workflow (console)

- Event state machine `draft → proposing → voting → decided → published → closed`, advanced by admins.
- Proposals/votes require GitHub login (`pending` allowed). Proposal = free text (title/body incl. date, place, topic). One vote per person, changeable while `voting`.
- In `decided` an admin picks the winner and uploads a poster (S3); `published` exposes `/events/{id}` publicly.

## CLI (`yyt`)

- `yyt login --token <API token>` (issued in console > account > API tokens), stored in `~/.config/yyt/config.json`.
- Every console API as subcommands (`members`, `auth-channels`, `topic-channels`, `match-channels`, `events`; `list/create/get/extend/rotate-secret/delete`), `--json` output.

## Priority

1 shared packages → 2 auth → 3 minimal console (login, members, channel CRUD, API tokens) → 4 match → 5 topic → 6 CLI → 7 hackathon workflow → 8 console SPA polish.
