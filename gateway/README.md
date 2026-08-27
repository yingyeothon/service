# yyt realtime gateway

One Go process that terminates WebSockets for `lobby` and `q` channels
(`docs/decisions.md` _Realtime gateway_). It runs as a single Docker
container on the stateful box, capped at 256 MB, with a design ceiling of 10
concurrent players. It shares no code with `packages/*` or tslib: every
contract is a wire format documented here.

## Configuration

| variable                               | required | meaning                                                                                          |
| -------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `GATEWAY_STAGE`                        | yes      | `dev` / `prod`; Redis namespace segment, must match the console's stage                          |
| `GATEWAY_CONSOLE_URL`                  | yes      | console API base, e.g. `https://console-dev.yyt.life`                                            |
| `GATEWAY_TOKEN` / `_FILE`              | yes      | shared secret for `GET /gw/channels/{id}` (SSM `/yyt-service/{stage}/gateway-token`, ≥ 32 chars) |
| `GATEWAY_REDIS_URL` / `_FILE`          | yes      | `redis://user:password@host:port/0`; the gateway's own ACL user (below)                          |
| `GATEWAY_LISTEN`                       | no       | default `:8080`                                                                                  |
| `GATEWAY_TLS_CERT` / `GATEWAY_TLS_KEY` | no       | in-process TLS; otherwise terminate at a reverse proxy                                           |
| `GATEWAY_CONFIG_TTL_SEC`               | no       | channel config cache, default 60                                                                 |
| `GATEWAY_SHUTDOWN_TIMEOUT_SEC`         | no       | SIGTERM drain bound, default 10                                                                  |
| `GATEWAY_MAX_CONNECTIONS`              | no       | live socket cap, default 64 (the design ceiling is 10 players)                                   |
| `GATEWAY_LOG_LEVEL`                    | no       | `debug` / `info` / `warn` / `error`                                                              |

The Redis account must span two namespaces (`docs/realtime-gateway-design.md`, key table):
`resetkeys ~gateway:{stage}:* ~game:{stage}:* resetchannels &game:out:{stage}:*`,
plus `-@dangerous` like every service account. It is created in the private
`yyt-stateful` repo, never here.

Endpoints:

- `GET /livez` — liveness: the process is up and not draining. **Wire the
  container restart policy / external restart check to this one.**
- `GET /healthz` — readiness: Redis pings and the console reports
  `configured: true` (probe cached 5 s); 503 otherwise or while draining. A
  console redeploy makes this 503 for a moment while every session keeps
  running — it must never restart the gateway.
- `GET /metrics` — JSON counters, gauges and runtime (`heapAllocBytes`,
  `sysBytes`, `goroutines`) for anyone; with `Authorization: Bearer
<GATEWAY_TOKEN>` it adds the per-channel slice (channel ids are targeting
  material, so they are not public). Alarm on `counters.aborts`,
  `counters.redisErrors`, `gauges.outboundQueueMax`, `runtime.sysBytes`
  against the 256 MB cap, and `rejected5xx`.
- `GET /?channel={channelId}[&gameId={gameId}]` — the WebSocket endpoint
  (`x-game-id` is accepted as an alias of `gameId`).

The image is distroless (no shell), so there is no Docker `HEALTHCHECK`; the
host probes `/livez`. The image carries
`org.opencontainers.image.source` pointing at this repository, so GHCR links
the package to it and gives it the repository's (public) visibility on first
publish — provided the organisation allows members to create public packages
(`Settings → Packages`). If it still comes out private, flip it once in the
package settings.

## Connect

```
new WebSocket("wss://gw.yyt.life/?channel=ch_…", ["bearer", jwt])          // lobby
new WebSocket("wss://gw.yyt.life/?channel=ch_…&gameId=g…", ["bearer", jwt]) // q
```

The token travels only in `Sec-WebSocket-Protocol`; the server echoes
`bearer`. It is verified by calling the auth channel named in the gateway
channel's config (`GET /c/{authChannelId}/verify`) and the answer is cached
until the JWT's `exp`, so one token serves both the lobby and the dungeon
socket.

Handshake refusals (HTTP, before upgrade): `400` no `channel`; `401` no or
rejected token (a token that is not even JWT-shaped, or whose `exp` has
passed, is refused without calling auth); `403` (`q`) unknown game or not in
its start event — one code for both, so a member cannot probe game ids;
`404` unknown or malformed channel id, or a non-gateway kind; `410`
expired/disabled channel; `429` more than 10 handshakes in a burst from one
address (refill 2/s); `502` console or auth unreachable; `503` gateway not
configured, full, over its auth budget (8 verifies in flight), or shutting
down.

Close codes the gateway sends:

| code   | meaning                                                     | client should                                                                    |
| ------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `4000` | replaced by a newer socket of the same user on this channel | stop; the other tab won                                                          |
| `4001` | `q`: the actor stopped consuming (abort)                    | show "server stopped responding", return to lobby; retry with a **new** `gameId` |
| `4002` | idle: no pong within 75 s                                   | reconnect                                                                        |
| `4003` | policy: 50 refused messages on one socket                   | fix the client                                                                   |
| `4004` | the channel expired or was disabled                         | stop                                                                             |
| `1000` | `q`: the game dropped you (`{op:"drop"}`) — a normal finish | show the result                                                                  |
| `1001` | gateway restarting                                          | reconnect with backoff (do not stampede)                                         |
| `1003` | binary frame received                                       | fix the client (text only)                                                       |
| `1009` | inbound frame over 16 KB                                    | fix the client                                                                   |
| `1011` | `q`: the enter push failed                                  | retry the connect                                                                |

Both strategies: text frames only, 16 KB inbound cap, 32 KB outbound cap
(larger gateway frames are dropped and counted), WebSocket ping every 30 s,
per-connection token bucket (lobby: the channel's `rateLimit`/s; q: 20/s;
burst 2×; over it → `error rate_limited`), and a 256-frame outbound queue
that drops the **oldest** pending frame under backpressure. Every refusal is a typed frame
`{ "type": "error", "code": "…", "message": "…" }`, never silence.

Connection ids are `{instance}:{random}`; `__FAKE_CONNECTION_ID__` is
reserved by tslib and never issued.

## `lobby` protocol

The gateway routes **scopes**, never semantics. Only `pos` and `party.*`
have gateway-side meaning; everything a game invents travels as `event`.

First frame, always:

```json
{
  "type": "hello",
  "userId": "…",
  "connectionId": "…",
  "tick": 200,
  "mapUrl": "https://d.yyt.life/…",
  "zone": "Zone001",
  "partyId": "pty_…",
  "capabilities": {
    "pos": true,
    "say": ["zone", "party", "user"],
    "party": true,
    "event": true,
    "debug": false
  }
}
```

`capabilities` is the channel's config object verbatim (the design sketch
showed a flat list; the object keeps the `say` scopes). `partyId` is present
when the gateway already knows the reconnecting player's party; after a
gateway restart the roster is loaded from Redis and arrives as the `party`
frame right after `hello` instead. `{type:"ping"}` is answered with
`{type:"pong"}` on a lobby channel (on `q` every type is the game's).

Client → gateway:

| type                             | fields                                                      | routed to                            | refused with                                                                         |
| -------------------------------- | ----------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| `pos`                            | `zone`, `x`, `y`, `dir?`                                    | everyone in `zone` (coalesced)       | `capability_off`, `bad_zone`, `move_too_far` (delta > `maxMoveDelta` within a zone)  |
| `say`                            | `scope` (`zone`\|`party`\|`user`), `to?`, `text` (≤ 1024 B) | that scope, sender included          | `capability_off`, `bad_scope`, `bad_zone`, `no_party`, `unknown_user`, `too_long`    |
| `event`                          | `scope`, `to?`, `name` (≤ 64 B), `payload` (≤ 8 KB, unread) | that scope, sender included          | same as `say`                                                                        |
| `party.create`                   | –                                                           | –                                    | `already_in_party`                                                                   |
| `party.invite`                   | `userId`                                                    | invitee gets `party.invite`          | `no_party`, `not_leader`, `unknown_user` (offline), `already_in_party`, `party_full` |
| `party.accept` / `party.decline` | `partyId`                                                   | party / leader gets `party.declined` | `unknown_party`, `not_invited`, `party_full`                                         |
| `party.leave`                    | –                                                           | party                                | `no_party`                                                                           |
| `party.list`                     | –                                                           | sender                               | –                                                                                    |

Gateway → client:

| type             | fields                                                                                  | when                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `snapshot`       | `zone`, `peers[]`                                                                       | you entered a zone (first `pos`, zone change, or reconnect with a retained position) — every peer already there |
| `enter`          | `zone`, `userId`, `x`, `y`, `dir`                                                       | a peer entered your zone                                                                                        |
| `leave`          | `zone`, `userId`                                                                        | a peer left your zone (zone change or disconnect)                                                               |
| `pos`            | `zone`, `peers[]`                                                                       | once per `flushIntervalMs` (`tick`), only peers that moved; includes you — filter your own `userId`             |
| `say` / `event`  | `from`, `scope`, `to?`, …                                                               | mirrored to the routed set                                                                                      |
| `party`          | `partyId` (`""` = no party), `leaderId`, `members[{userId,online}]`, `invited[]`, `max` | roster snapshot on every change, and on reconnect                                                               |
| `party.invite`   | `partyId`, `from`                                                                       | you were invited                                                                                                |
| `party.declined` | `partyId`, `userId`                                                                     | (leader) an invite was refused                                                                                  |
| `error`          | `code`, `message`                                                                       | any refusal                                                                                                     |

A player has no zone until their first `pos`; `hello.zone` is only the
default the game should start in. A zone change is decided by the game's HTTP
API — the client re-announces with the new `zone` and the gateway emits
`leave` to the old zone and `snapshot`/`enter` for the new one. Whispers
(`say`/`event` with `scope:"user"`) are routed by `userId` from the connection
table and work across zones. **Zones are not private**: any client may
announce itself into any zone name and receive that zone's snapshot — zone
access is the game's rule, and the gateway does not enforce it.

Disconnect keeps the retained position (`gateway:{stage}:pos:…`, 30 min
sliding) and the party membership (`gateway:{stage}:party:…` +
`partyOf:…`, 30 min sliding, refreshed on change); a reconnect resumes both,
and the roster marks the member `online:false` in between. Only an explicit
`party.leave` or the TTL removes a member; an empty party dissolves. A
pending invite dies with the invitee's socket, a repeated invite to the same
user sends no second frame, and at most `partySizeMax × 2` invites are
pending. The game's entry API reads the roster JSON from Redis
(`{"id","leaderId","members":[…],"invited":[…]}`) rather than believing a
client. Leadership passes to the next member when the leader leaves.

## Party roster for games

A game's dungeon-entry API must know who is in a party without believing the
client that named it, and a participant's Redis credential (as issued today)
cannot read the gateway's keys. So the gateway serves the roster it mirrored
(the store now supports read-only ACL selectors, so a direct Redis read may
become an option — `todo/16`; this route stays regardless):

```
GET /parties/{partyId}?channel={lobbyChannelId}
Authorization: Bearer <jwt>
```

The bearer is a **member's** channel JWT (the game's HTTP API forwards the
caller's own token); it is verified the same way a handshake is, and cached
the same way. The answer is the `party` frame shape —
`{ "type":"party", "partyId", "leaderId", "members":[{ "userId","online" }],
"invited":[…] }` — with `online` derived from the lobby session keys, so it
is correct across a gateway restart. Refusals: `400` no `channel`; `401` no
or rejected bearer; `404` unknown channel, a non-`lobby` channel, **an
unknown party, or a party the bearer is not a member of** (one code, so
party ids cannot be probed); `410` expired/disabled channel; `429` the same
per-address bucket as handshakes; `502` console/auth/Redis unreachable. The
route reads Redis only (one `GET` + one `MGET`) — it never touches the
in-memory hub — and has its own per-address bucket, so a game's Lambda egress
address and the players behind one NAT do not spend each other's budget.
`/metrics` counts it as `partyReads` / `partyRejected`.
`examples/sample-morpg/src/entry.ts` is the reference consumer.

## `q` protocol

The bridge to a tslib actor (`@yingyeothon/lambda-gamebase`), replacing
`handleConnect`/`handleMessages`/`handleDisconnect`.

On connect: verify the token → load `{eventKeyPrefix}{gameId}` and require
`members[].memberId == sub` → `SUBSCRIBE {channelPrefix}{gameId}` **before**
anything is pushed → close a previous socket of the same member (`4000`) →
`RPUSH {queueKeyPrefix}{gameId}` the tslib envelope
`{"messageId":uuid,"awaitPolicy":0,"awaitTimeoutMillis":0,"item":{"type":"enter","connectionId","memberId"}}`
and `EXPIRE` it to 15 min (the backstop for a queue nobody drains when the
gateway itself dies).

Inbound frames must be a JSON object with a string `type` that is not
`enter`/`leave` (`error reserved_type`); the gateway overwrites
`connectionId` with its own, strips any client-supplied `memberId`, and
pushes `{…, "connectionId"}` in the same envelope. **`connectionId` is the
only field an actor may trust**; resolve the member from the `enter` it
received for that connection. A push Redis refuses is answered with `error
unavailable`; three in a row abort the game (`4001`). Outbound `GatewayCommand`s (`{op:"send", connectionId|connectionIds,
message}` / `{op:"drop", connectionId}`) are fanned out; `message` is
forwarded verbatim. On disconnect `{"type":"leave","connectionId"}` is pushed
and the subscription is dropped with the last socket of the game.

Actor death is detected from the depth `RPUSH` returns: depth > 200, or
depth > 20 for more than 5 s without dipping back, aborts the game — every
socket closes with `4001`, the queue key is deleted, the subscription is
dropped, `aborts` increments and an error line is logged. A retry must use a
new `gameId`.

## Sessions and keys

One socket per `(kind, channel, user)`: a newer one replaces the older
(`4000`). A lobby socket and a q socket may coexist. The binding is mirrored to
`gateway:{stage}:session:{kind}:{channelId}:{userId} -> connectionId` (15 min,
compare-and-delete on release) so the game's HTTP API can see who is online.
Every key the gateway writes has a TTL; the layout is the key table in `docs/realtime-gateway-design.md`.

## Build, run, release

```
cd gateway && go test -race ./... && go build ./cmd/gateway
GATEWAY_STAGE=dev GATEWAY_CONSOLE_URL=https://console-dev.yyt.life \
GATEWAY_TOKEN_FILE=../local/deploy/gateway-token.dev \
GATEWAY_REDIS_URL=redis://… ./gateway
```

`docker build -t yyt-gateway gateway/` produces a distroless static image
(non-root; the Dockerfile cross-compiles from `$BUILDPLATFORM`, so the
multi-arch release needs no QEMU). Tagging `gateway/vX.Y.Z` runs `.github/workflows/gateway-release.yml`,
which tests, builds `linux/amd64,arm64` and pushes
`ghcr.io/yingyeothon/yyt-gateway:{X.Y.Z,latest}`. The private `yyt-stateful`
repo pulls and runs it (restart policy, 256 MB limit, TLS at its proxy or via
`GATEWAY_TLS_*`), sets SSM `gateway-ws-url` so console renders `wsUrl`, and
points `gw{-dev}.yyt.life` at the box.

## Consuming the image

Published on every `gateway/vX.Y.Z` tag as `ghcr.io/yingyeothon/yyt-gateway`
with three tags: `:X.Y.Z` (immutable), `:main` (always the newest release —
what the box pulls) and `:latest` (same as `:main`). Public, multi-arch
(`linux/amd64`, `linux/arm64`), no login needed:

```
docker pull ghcr.io/yingyeothon/yyt-gateway:main
```

Minimal run (secrets as files so they never show in `docker inspect`; the
Redis user is the gateway's own ACL account, see _Configuration_):

```
install -d -m 700 /etc/yyt-gateway
printf '%s' "$GATEWAY_TOKEN" > /etc/yyt-gateway/token            # SSM /yyt-service/dev/gateway-token
printf 'redis://<gateway-redis-user>:%s@127.0.0.1:6379/0' "$PW" > /etc/yyt-gateway/redis-url
chmod 600 /etc/yyt-gateway/*

docker run -d --name yyt-gateway-dev --restart unless-stopped \
  --network host --memory 64m --memory-swap 64m --read-only \
  -e GOMEMLIMIT=48MiB \
  -v /etc/yyt-gateway:/run/secrets:ro \
  -e GATEWAY_STAGE=dev \
  -e GATEWAY_CONSOLE_URL=https://console-dev.yyt.life \
  -e GATEWAY_TOKEN_FILE=/run/secrets/token \
  -e GATEWAY_REDIS_URL_FILE=/run/secrets/redis-url \
  -e GATEWAY_LISTEN=:8080 \
  ghcr.io/yingyeothon/yyt-gateway:main
curl -s http://127.0.0.1:8080/livez
```

`--network host` is what lets `127.0.0.1:6379` reach the Redis that runs on
the same box as a systemd service. One container per stage (`dev` on 8080,
`prod` on 8081, say). Measured footprint: **8.7 MiB RSS** (Go heap 2.3 MB,
runtime 13 MB reserved) while the smoke drives it, so `--memory 64m` for dev
and `128m` for prod are generous — the 256 MB in the original design was a ceiling,
not a need. `GOMEMLIMIT` at ~75 % of the cap makes the GC work harder
before the kernel OOM-kills; TLS terminates in front of it (Caddy/nginx with Let's
Encrypt for `gw{-dev}.yyt.life`, proxying `/` as a WebSocket upgrade) or in
process with `GATEWAY_TLS_CERT`/`GATEWAY_TLS_KEY` mounted the same way.

Upgrade = pull `:main` and recreate the container; every player is
disconnected with `1001`, so do it before an event, never during:

```
docker pull ghcr.io/yingyeothon/yyt-gateway:main
docker rm -f yyt-gateway-dev && docker run … (as above)
```

The step-by-step box setup lives in the private `yyt-stateful` repo
(`todo-gateway.md`): ACL user, secret files, container, proxy, DNS, and the
console's `gateway-ws-url` parameter that makes `wsUrl` appear on channel
pages.

Smoke against dev: `scripts/smoke/gateway.mjs <gatewayWsUrl> <debugKey> <authBaseUrl> <consoleBaseUrl>`.

Never log tokens: the `Sec-WebSocket-Protocol` header carries the credential,
`hello` carries none, and every log line names ids and outcomes only.
