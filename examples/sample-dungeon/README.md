# sample-dungeon — tslib game stack wired to the yyt services

The contest-day starting point: an instant dungeon on `@yingyeothon/lambda-gamebase` + `gamebase-all-together` that accepts the **auth service's JWT unchanged** and is started by the **match service's signed callback**. Copy this directory, rename the service, replace `src/game.ts`.

```
client ──JWT──▶ match WS ──party──▶ POST /match-callback (signed) ──▶ actor Lambda
   │                                        │ {wsUrl, gameId}
   └──────── same JWT, ?x-game-id=… ─────▶ dungeon WS ($connect authorizer) ──▶ game loop
```

## Layout

| File                | Role                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/handler.ts`    | Lambda entry points (`authorizer`, `ws`, `actor`, `matchCallback`, `matchCallbackTopic`); the only module reading env.   |
| `src/env.ts`        | Env contract + Redis key prefixes.                                                                                       |
| `src/lobby.ts`      | `POST /match-callback`: verify `X-Yyt-Signature` → save `GameActorStartEvent` → invoke actor → `{wsUrl, gameId}`.        |
| `src/topicLobby.ts` | `POST /match-callback-topic`: the server-less alternative — opens a topic room for the party and returns its `wsUrl`.    |
| `src/actor.ts`      | `handleActor` + `runGameAllTogether` with the dungeon hooks.                                                             |
| `src/game.ts`       | Pure rules (boss HP, attack clamp, snapshot). **Replace this.**                                                          |
| `src/signature.ts`  | HMAC verification of the matchmaker callback.                                                                            |
| `serverless.yml`    | WebSocket API (REQUEST authorizer on `$connect`, identity source `Sec-WebSocket-Protocol`, cache off) + httpApi + actor. |
| `scripts/deploy.sh` | `scripts/deploy.sh <env-file> [stage]` — sources the env file, then `serverless deploy`.                                 |
| `env.example`       | Every variable the stack needs. Real files live outside git (`../../local/`).                                            |

## Identity contract (docs/auth-game-contract.md)

- The dungeon verifies the auth service's token with the **auth channel secret** (`JWT_SECRET_KEY`), `iss = yyt-auth/{authChannelId}` and `aud = channel.audience`. No re-signing: the client reuses the JWT it already holds for the match socket, so the callback response carries no `token`.
- `sub` (the auth `userId`) is copied verbatim into `GameActorStartEvent.members[].memberId` (`src/lobby.ts#toStartEvent`); `$connect` compares the two and fails closed on anything else.
- The wait stage ends early only when **every** member connected; with `minPlayers: 1` a missing member still costs the full `gameWaitingSeconds` (20 s) before the game starts short-handed.
- Token lifetime is the auth channel's `tokenTtlSec` (default 24 h), longer than the contract's 60-minute floor — fine for a contest; shorten the channel TTL if it matters.

## Protocol (what `src/game.ts` defines)

| Direction | Message                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| client →  | `{"type":"attack","power"?:n}` (`power` clamped to 1..10)                                                         |
| server →  | `{"type":"stage","payload":{"stage":"wait"\|"running"\|"end","age"}}`                                             |
| server →  | `{"type":"enter","payload":{"memberId"}}`                                                                         |
| server →  | `{"type":"snapshot","payload":{"bossHp","bossMaxHp","damage","connected"}}` (on enter/reconnect and every second) |
| server →  | `{"type":"hit","payload":{"memberId","dealt","bossHp"}}`                                                          |
| server →  | `{"type":"result","payload":{"reason","damage"}}` then the `end` stage; the server drops the sockets ~1 s later   |

`enter`/`leave` are reserved by tslib; `handleMessages` refuses them from clients (`validateMessage` only admits `attack`).

## Deploy

1. Create an **auth channel** and a **match channel** in the console (or via the `yyt` CLI). Note the auth channel `secret`/`audience` and the match `apiKey` — both are shown once.
2. Fill an env file from `env.example`; Redis is yours (any Redis 6+ reachable from Lambda; `REDIS_USER` optional for ACL users). `REDIS_KEY_PREFIX` must match the ACL key pattern.
3. `pnpm install` (see below) and `scripts/deploy.sh <env-file> dev`. The output prints the `CallbackUrl`; set it as the match channel's `callbackUrl` (full config replace on PATCH).
4. Smoke from the service repo: `scripts/smoke/dungeon.mjs` (`setup` → deploy → `run` → `clean`), which does steps 1–3 against `dev` with the debug hooks.

### Gateway mode (sockets in the yyt realtime gateway)

The same stack can terminate the party's sockets in the platform's realtime gateway (`gateway/README.md`, _q protocol_) instead of its own WebSocket API — the shape a contest game is expected to use:

1. Create a **`q` channel** on the same auth channel in the console; its page shows `wsUrl` (`wss://gw.yyt.life/?channel=<id>`) and issues a **participant Redis credential** (shown once) scoped to `game:<stage>:<id>:*` / `game:out:<stage>:<id>:*`.
2. In the env file set `GATEWAY_WS_URL` to that `wsUrl` and `REDIS_HOST/PORT/USER/PASSWORD` to the credential, with `REDIS_KEY_PREFIX=game:<stage>:<id>:` (the four tslib prefixes derive from it in `src/env.ts` and match what the console shows; the outbound pub/sub prefix `game:out:<stage>:<id>:` is derived too, never typed in).
3. Deploy as above. The match callback now returns the gateway `wsUrl`; the client opens `${wsUrl}&gameId=${gameId}` with the same `["bearer", jwt]` subprotocol. The `ws`/`authorizer` functions and `WS_URL` stay deployed but are never invoked; the actor publishes `GatewayCommand`s over Redis pub/sub (`createRedisPubSubTransport`) and the gateway fans them out.
4. Refusals arrive as HTTP handshake statuses (`401`/`403`/`404`/`410`), not as a socket that opens and closes. Close codes: `1000` = the game dropped you (normal finish), `4001` = the actor stopped consuming (retry with a new game), `4000` = replaced by a newer socket of the same user — table in `gateway/README.md`.

Smoke: `scripts/smoke/dungeon.mjs setup … <outEnvFile> <outStateFile> gateway` creates the `q` channel and credential and writes them into the env file; `run` detects the mode from the callback's `wsUrl`. Never commit that env file (`local/` is gitignored).

Sizing: `actor` timeout (180 s) ≥ `gameWaitingSeconds + gameRunningSeconds + LIFETIME_MARGIN_SECONDS` in `src/actor.ts`; the start event TTL uses the same sum. Set `maximumRetryAttempts: 0` on the actor — a retried game would replay from the start.

## Copying this directory

`git archive`/`rsync --exclude node_modules --exclude .serverless` it (never `cp -r` with `node_modules/` and `.serverless/` — the latter holds the previous account's deploy state). The tsconfig is self-contained. Then `pnpm install && pnpm typecheck`.

Prerequisites: Node ≥ 22, pnpm, Serverless Framework v4 CLI (`npm i -g serverless`, logged in or `SERVERLESS_ACCESS_KEY`), an AWS profile.

## tslib resolution

`@yingyeothon/*` 2.0.0 is on npm; `pnpm-workspace.yaml` only makes this directory its own pnpm root. To test an unpublished tslib change, add `overrides: {"@yingyeothon/<pkg>": "link:/abs/path/to/tslib/packages/<pkg>"}` there (built with `pnpm build` in tslib) — a clean `pnpm install` does not prove such links resolve, only `pnpm typecheck` does.

## Logs

`serverless logs -f matchCallback|authorizer|ws|actor --stage dev` (CloudWatch `/aws/lambda/<service>-<stage>-<fn>`). A game that connects but never sends `stage`/`snapshot` means the actor crashed or timed out: read the `actor` log; the start event and actor lock expire after the game lifetime (~3 min), after which the gameId is gone for good.

## Checks

`pnpm typecheck && pnpm lint && pnpm test` — unit tests cover the signature, the lobby handlers (with fakes) and the rules. The game loop itself is tslib's; the dev smoke is the integration test.
