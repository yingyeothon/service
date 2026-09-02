# Contest-day playbook — a game server in 2–3 hours

Verified end to end on `dev` with `sample-dungeon` from [`yingyeothon/examples`](https://github.com/yingyeothon/examples) (2026-08-23): auth JWT → match → signed callback → dungeon actor, and the server-less variant (callback → topic room). Follow the order; each step has a check.

## 0. Before the day (organizer)

- `prod` stacks deployed (`todo/10-prod-launch.md`), console reachable, members approved.
- tslib built and available (`~/git/yyt.life/tslib`, `pnpm build`) or published to npm.
- Each team has: a console login, the `yyt` CLI, an AWS account/profile for their own stack, Serverless Framework v4 CLI (`npm i -g serverless`, logged in), a Redis they own (any Redis 6+; ACL user optional).
- Each team registers a GitHub OAuth app (any placeholder callback URL for now) and keeps its client id/secret; the real callback is set in step 1.

## 1. Channels (10 min) — console or CLI

```sh
yyt login --api https://console.yyt.life --token <api-token>
yyt team create teamA && yyt team use teamA           # or `yyt team join teamA` and wait for the owner
yyt project create dungeon && yyt project use dungeon # channels live in a project; `use` pins the context
yyt channels create --kind auth  --name teamA --audience teamA-dungeon \
    --github-client-id … --github-client-secret …        # prints secret ONCE
yyt channels create --kind match --name teamA-match --auth-channel teamA \
    --party-size 2 --wait-timeout 60 --on-timeout partial \
    --callback-url https://example.invalid/match-callback # replaced in step 4; prints apiKey ONCE
# optional, server-less rooms:
yyt channels create --kind topic --name teamA-topic --auth-channel teamA   # prints apiKey ONCE
```

Then set the OAuth app's callback to `https://auth.yyt.life/c/<auth-id>/github/callback` and allow the game's page: `yyt channels update teamA --redirect https://<game-page>`. (Names are unique within the team, so the three channels need different names; `--auth-channel` takes the auth channel's name.) Smoke without a browser: `POST /c/<auth-id>/token {provider, accessToken}` (`docs/decisions.md`).

Check: `yyt channels list` shows all `active`.

## 2. Copy the sample (5 min)

```sh
git clone https://github.com/yingyeothon/examples.git && mkdir -p ~/teamA-server
git -C examples archive HEAD sample-dungeon | tar -x -C ~/teamA-server --strip-components=1 && cd ~/teamA-server
sed -i 's/^service: .*/service: teamA-dungeon/' serverless.yml
pnpm install && pnpm typecheck && pnpm test
```

## 3. Env + deploy (10 min)

Fill `env.example` → `~/teamA.env` (never in git): `JWT_SECRET_KEY` = auth secret, `JWT_ISSUER=yyt-auth/<auth-id>`, `JWT_AUDIENCE` = the audience from step 1, `MATCH_API_KEY` = match apiKey, `REDIS_*`, `REDIS_KEY_PREFIX=game:dev:` (+ `TOPIC_*` for rooms).

```sh
AWS_PROFILE=teamA scripts/deploy.sh ~/teamA.env dev
```

Output lists `POST …/match-callback` (the `CallbackUrl`) and the `wss://…` endpoint. Warm it once so the first match does not hit a cold start inside the matchmaker's 5 s callback budget: `curl -s -o /dev/null -w '%{http_code}\n' -X POST <CallbackUrl>` → `401`.

## 4. Point the matchmaker at it (2 min)

```sh
yyt channels update <match-id> --callback-url https://<api-id>.execute-api.ap-northeast-2.amazonaws.com/match-callback
```

Config is cached by the match service for 60 s; wait a minute before the first match if the channel was used already.

## 5. Smoke (10 min)

From the service repo, against `dev` with debug hooks (organizer machine), or by hand:

1. Two browsers/devices log in through `https://auth.yyt.life/c/<auth-id>/start?provider=github&redirect=…` → each has a JWT.
2. Both connect `wss://match.yyt.life/?channel=<match-id>` with subprotocols `["bearer", jwt]` → both receive `{"type":"matched","result":{"wsUrl","gameId"}}`.
3. Each connects `${wsUrl}?x-game-id=${gameId}` with the same `["bearer", jwt]` → `stage wait` → `running` → send `{"type":"attack"}` → `result`.

Automated equivalent (organizer only): the `dungeon` smoke in `yingyeothon/examples` `local/smoke/` (`rules/manual-verification.md`). A reconnect with the same JWT gets a `snapshot`; an outsider's JWT is refused at `$connect`.

## 6. Build the game (rest of the day)

- Replace `src/game.ts` (rules) and the hooks in `src/actor.ts`. `processMessage` gets `{context, message}`; `onSnapshot` every `snapshotIntervalMillis`; switch `tick` to `{mode:"fixed", intervalMillis}` for real-time simulation.
- Keep `$connect` (`resolveMemberId` from the authorizer context, `selectSubprotocol: bearer`) and the callback handler as they are; they are the contract with the services.
- Redeploy with the same command; the actor Lambda timeout must stay above waiting + running + 20 s.

## Failure table

| Symptom                                          | Cause → fix                                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| match: `{"type":"failed","reason":"callback"}`   | callbackUrl unreachable / non-2xx / stale 60 s cache; `matchCallback` log says `signature rejected` → wrong `MATCH_API_KEY` |
| dungeon handshake fails (401)                    | `JWT_SECRET_KEY`/`JWT_ISSUER`/`JWT_AUDIENCE` differ from the auth channel                                                   |
| dungeon handshake fails (400)                    | not in the party, wrong `x-game-id`, or the actor's start event expired (TTL = game lifetime)                               |
| `NOPERM` in the actor log                        | `REDIS_KEY_PREFIX` outside the Redis ACL user's pattern                                                                     |
| dungeon connects but no `stage`/`snapshot`       | actor crashed or timed out — `serverless logs -f actor`; the gameId expires with the start event (~3 min), re-match         |
| first match `failed/callback` right after deploy | callback cold start exceeded the matchmaker's 5 s timeout — warm it (§3) and re-queue                                       |
| clients never get `result`                       | tslib < the `endDropDelayMillis` change — the drop raced the last frame                                                     |

Logs: `serverless logs -f <authorizer|ws|actor|matchCallback> --stage dev`. Tear down: `serverless remove --stage dev`.

## AI-agent prompt template

```
You are setting up a game server for the Yingyeothon contest. Repository: <path to the copied sample-dungeon>.
Contract docs: docs/auth-game-contract.md in yingyeothon/service and sample-dungeon/README.md in yingyeothon/examples.
Do not change src/handler.ts's $connect wiring or the /match-callback handler. Implement the game in src/game.ts
and the hooks in src/actor.ts: <describe the rules and the client messages>. Keep pure rules testable in vitest
(test/game.test.ts). Deploy with `scripts/deploy.sh <env-file> dev` and verify with two WebSocket clients as in
docs/playbook-contest-day.md §5. Never print or commit the env file.
```
