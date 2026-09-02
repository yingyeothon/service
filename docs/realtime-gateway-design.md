# Realtime gateway — design record

Rationale and rejected alternatives behind the `lobby`/`q` gateway. The settled
decisions are in `docs/decisions.md` (_Realtime gateway_, _Storage shapes_); the
wire protocol, configuration and release process are in `gateway/README.md`;
the reference game is `sample-morpg` in `yingyeothon/examples`; the tslib half of the
contract is documented in the tslib repo. This file only keeps the reasoning
that those do not repeat. Superseded the `todo/14` design draft on 2026-08-28.

## Why Go, why one process

- The gateway is a long-running process holding sockets and per-connection
  buffers under a small memory cap on a host shared with MariaDB and Redis;
  that floor rules out a JS runtime. Go was chosen over Rust because the Go
  toolchain and release pattern (`cli/`) already existed in the repo.
- Consequence: the gateway shares **no code** with `packages/*` or tslib.
  Every contract (message envelope, `GatewayCommand`, start-event membership,
  key prefixes, the numeric `AwaitPolicy` enum) is a written wire spec, not a
  shared type, so it must be documented precisely on both sides.
- One process, by decision: sticky routing is free, the lobby peer index is
  global, and cross-instance position replication must not be built. A deploy
  disconnects everyone; deploy before the event and make clients reconnect.
- Area-of-interest filtering was deferred, not rejected (corrected
  2026-09-01) and built 2026-09-02 (`docs/decisions.md` _Realtime gateway_):
  an optional per-channel box (`aoi.range`) inside the zone, plus a peer cap
  (`maxPeers`) that applies to every lobby channel.
  The constraint that shaped it: what clients depend on is the synthesised
  `enter`/`leave`, so AOI had to redefine them — each connection owns its
  view, every `enter`/`leave` is a diff of that view, and a peer leaving your
  _view_ produces a `leave` even though it never left your zone, or the
  frozen-character bug those frames exist to prevent comes straight back.
  The same bug is why the view invariant (`docs/decisions.md`, 2026-09-02)
  is enforced structurally: peer frames are sent under the hub lock, control
  frames are never dropped (`4005` closes a client that cannot drain them),
  and the always-on `maxPeers` cap keeps every frame under the outbound cap.
  Without `aoi.range` the range is the whole zone.
- The gateway reads channel config over HTTP from the console rather than
  through a MariaDB driver: it stays out of the connection budget and does not
  become a second schema consumer. The cost is one HTTP hop per cache miss.

## Not a port of mmo101: a protocol change

The original game sent `Move { dir }` and the server resolved terrain; the wire
format had no client position and no zone. The gateway's lobby is
client-authoritative (`pos { zone, x, y, dir }`), validating only rate and
per-message movement delta, never terrain. Zone changes are decided by the
game's HTTP API (a rule-free relay cannot own them); the client re-announces
and the gateway emits leave/enter from retained state. Budget client work
accordingly.

## Redis: namespaces, ACL asymmetry, TTLs

The platform Redis is one shared instance with a memory cap and `allkeys-lru`,
one ACL user per service × stage. Game traffic breaks that model in two ways: an
inbound queue is a **list that grows** when its actor dies, and LRU eviction
would take platform keys (sessions, match tickets) first. Containment is
therefore mandatory:

- Two namespaces, both stage-scoped because one instance serves both stages:
  `gateway:{stage}:` (gateway-owned state) and `game:{stage}:{channelId}:` plus
  pub/sub `game:out:{stage}:{channelId}:` (the actor bridge, shared with the
  participant's Lambda). Prefixes are **derived from the channel id**, never
  configured: a prefix mismatch across gateway / tslib / participant is a
  silent no-op (a push to a key nobody reads), so deriving removes the failure
  mode. tslib's `handleActor` needs four prefixes (`event`, `queue`, `lock`,
  `awaiter`); anything a participant names themselves falls outside their ACL
  and fails `NOPERM` at actor start.
- ACL asymmetry is deliberate: the platform-operated gateway is granted the
  whole `game:{stage}:*` subtree; a participant's per-channel account
  (issued by console, `docs/decisions.md` _state service_) is scoped to its own channel only, so a
  wrong prefix fails instead of leaking another game's queue. Abuse is handled
  socially at an in-person event; what is not optional is per-prefix key
  count and memory observability.
- Every key has a TTL (`KEYS`/`SCAN` are removed from the ACL users, so an
  untracked key can never be found again):

  | key                                            | holds             | TTL                               | why                                |
  | ---------------------------------------------- | ----------------- | --------------------------------- | ---------------------------------- |
  | `{queueKeyPrefix}{gameId}`                     | inbound list      | dungeon lifetime + margin (~15 m) | a run is capped at 12 min          |
  | `{eventKeyPrefix}{gameId}`                     | start event       | same                              | cleared by the actor on start      |
  | lock key                                       | actor lock        | `lifetimeSeconds + 10`            | tslib-owned, not verified here     |
  | `gateway:{stage}:pos:{ch}:{userId}`            | retained position | sliding ~30 m                     | reconnect re-enters where it left  |
  | `gateway:{stage}:party:{ch}:{partyId}`         | roster            | sliding ~30 m                     | survives a reconnect, not a logout |
  | `gateway:{stage}:partyOf:{ch}:{userId}`        | reverse index     | same as roster                    | must not outlive it                |
  | `gateway:{stage}:session:{kind}:{ch}:{userId}` | socket binding    | ~15 m, refreshed                  | dies with the process anyway       |
  | channel config cache                           | console read      | 60 s                              | platform-wide cache rule           |
  | token-verify cache                             | JWT verify result | until `exp`, capped at 24 h, LRU  | see below                          |

- Party lifetime: a party must survive a network drop mid-run but not a logout
  (a party that outlives a session is a guild). Hence Redis with a sliding TTL,
  gateway-owned, never MariaDB — which also keeps party operations off the
  connection budget.

## Auth load

`GET /c/{ch}/verify` reads the secret-bearing channel row on every call and
that row must not be cached in Redis; auth's reserved concurrency is small and a
dungeon start bursts one connect per party member. The gateway-side verify cache
keyed by a token hash until `exp` is therefore mandatory, not an optimisation;
raising auth's concurrency would spend the MariaDB budget and is the fallback,
after measuring. The JWT `sub` must equal `GameActorStartEvent.members[].memberId`.

## Inbound list, outbound pub/sub (pub/sub-both-ways rejected 2026-08-25)

Replacing the inbound list with pub/sub was evaluated and rejected. The Redis
saving is noise (≈20 ops/s per dungeon). What the list buys:

- Durability across the startup race: the gateway may push before the actor
  loop is up. Pub/sub inbound would add a second ordering invariant
  (actor subscribes → `readyCall` → loop) that must hold on every path.
- Inbound is not self-healing: outbound frames are self-contained snapshots
  (a lost frame is corrected by the next tick — which is exactly why pub/sub
  is acceptable there), but inbound messages are discrete non-idempotent
  events; a dropped "attack" is gone.
- Redis closes slow pub/sub subscribers (`client-output-buffer-limit pubsub`):
  a few seconds' stall in the game loop would become silent total input loss
  for the rest of the run. A list absorbs the stall.
- `LLEN`/`RPUSH` depth is a queue-depth signal and the basis of actor-death
  detection; pub/sub has no equivalent.

The list's own risk — an actor dies while the gateway keeps pushing — is what
the gateway-side abort (depth cap + no-progress timeout, `docs/decisions.md`)
and the queue TTL backstop exist for. The abort covers "actor died, gateway
alive"; the TTL covers "gateway died after pushing".

## Where the game's nouns landed

| noun                                 | shape     | where                                                            |
| ------------------------------------ | --------- | ---------------------------------------------------------------- |
| map, NPC definitions                 | asset     | console assets resource, public CDN (decisions _Storage shapes_) |
| character, inventory, quest progress | doc       | state service, versioned JSON + CAS                              |
| party                                | ephemeral | the gateway (table above)                                        |
| dungeon runtime (monsters, combat)   | ephemeral | the actor's memory; Redis only for reconnect                     |

Deliberately not generalised: what a character or an item _is_ — that schema
lives inside the doc body and the platform never interprets it.

## Explicitly out of scope

- The match service is unused by this game (parties form in-world; the lobby
  invokes the dungeon actor directly). It stays as a generic primitive.
- The topic service is superseded for this use case (20-minute cap, per-message
  billing, no identity) but stays as the zero-setup primitive. A chat-only
  `lobby` channel is deliberately "a better topic".
- Leaderboards, reward commit, idempotency: the game's own store.
- Token revocation/refresh: rotation is the only lever; bans drop the socket.
- A server-initiated lobby push: if ever needed, add
  `POST /lobby/{channelId}/publish` mirroring topic's publish route rather than
  a new mechanism. Not built.
