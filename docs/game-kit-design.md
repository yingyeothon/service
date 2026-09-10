# Game kit: purpose-shaped client libraries

Design of record for the client side of the platform, decided 2026-09-08
(`docs/decisions.md` _Game kit_). The server exposes **capabilities** —
auth, gateway, kv, leaderboard, social, match — each generic and composable.
The client libraries expose **purposes** — the things a game actually does —
and compose the capabilities underneath. A game developer names a room, a
save, a board, an inbox, a friend; never a scope, a namespace, a frame or a
route.

This page is the language-neutral spec. The three library repositories
(`tslib`, `csharplib`, `flutterlib`) implement it with the same module names,
method names, event names and error codes, adapted only in casing and in the
async/event idiom of each language. The wire contracts they sit on stay where
they are (`gateway/README.md`, `services/state/README.md`,
`docs/auth-game-contract.md`).

## Principles

1. **Two layers, one direction.** _Wire_ packages map 1:1 onto a server
   surface and stay published as they are: `gamebase-client` (gateway),
   `kvstore-client` (kv), `auth-client` (auth), plus a small `platform-client`
   for the HTTP surfaces that have no package yet (`/lb`, `/social`, `/time`,
   the match socket). The _kit_ is one umbrella package —
   `@yingyeothon/game-kit`, `Yingyeothon.GameKit`, `yingyeothon_game_kit` —
   whose modules use only the wire packages' public API. A game that needs
   the wire imports a wire package explicitly; the kit never re-exports
   frames, routes or URLs.
2. **A module is named after a purpose and owns its vocabulary.** `room`,
   not "party + event scope"; `save`, not "user-scope collection";
   `board.submit`, not "PUT /lb/{board}/scores/me". A module's public types
   are the game's nouns (member, move, score, letter, friend), and its
   implementation choices (which scope, which frame name, which header) are
   private and may change without a major version.
3. **One kit, one credential, one config.** `createGameKit(config)` takes the
   block the console prints for the project (below) and the session's token;
   every module shares the session, the server clock, the gateway socket and
   the HTTP client. Modules connect lazily and independently, so a chess game
   never opens a match socket and a single-player game never opens the
   gateway.
4. **Same behaviour in three languages, proven the same way.** Every module
   has a written scenario list (below) that each repository's tests cover
   against an in-process fake (`fake_gateway` exists in flutterlib and is
   ported; a fake state server is added beside it). A scenario, an error code
   or an event name added in one repo is added to this page first.
5. **Honest about trust.** Where a module lets a client write what a server
   should (a score under `submit: owner`, a reward a host client decided), the
   API says so in its name or its docs — `board.submit` documents that an
   `owner` board is trusted, `room` calls the host "authoritative by
   agreement". The kit never pretends a client-side check is a server-side
   one.
6. **Never hold what the origin cannot protect.** The session keeps the token
   in memory by default; a storage adapter is opt-in, off on the web (the
   shared `g.yyt.life` origin, `docs/decisions.md` _Static sites_ #1) and a
   secure-store adapter on mobile. No module logs a token, a key or an owner
   id.

## The config block

Printed by the console once per project (`GET /projects/{prj}/kit-config`,
`yyt project kit-config`) and pasted into the game's `config.json` / asset /
scriptable object. Everything in it is public — **shipped 2026-09-10**.

Two rules the route follows, both worth keeping if it grows: a section whose
stack the stage does not have, or whose channel the project does not hold, is
**absent** rather than empty, because a kit module with no config fails on first
use instead of connecting to nowhere; and with several channels of a kind it
answers `400 ambiguous` and asks for `?auth=`/`?lobby=`/`?match=` (id or name)
rather than picking one — a wrong guess would be a _working_ config pointing at
the wrong channel, which surfaces as an empty lobby rather than as an error.

```json
{
  "auth": {
    "url": "https://auth.yyt.life",
    "channelId": "auth_…",
    "provider": "github"
  },
  "state": { "url": "https://doc.yyt.life" },
  "gateway": { "url": "wss://gw.yyt.life", "lobbyChannelId": "ch_…" },
  "match": { "url": "wss://match.yyt.life", "channelId": "ch_…" },
  "collections": { "save": "save", "content": "content", "mail": "mail" },
  "boards": { "weekly": "score-weekly", "speed": "best-time" }
}
```

Names under `collections`/`boards` are the game's aliases; the values are the
console names. The route emits identity pairs (`{"save": "save"}`) because the
console does not know the game's aliases -- the example above is what the block
looks like after a game has renamed its own side. `match`, `mail`, `boards` are
optional; a module whose config is absent throws `not_configured` on first use
rather than at construction, and an **empty** `collections`/`boards` is
therefore omitted too rather than sent as `{}`.

## Modules

Method names are given in TypeScript casing; C# is `PascalCase` + `Async`
suffix on awaitables, Dart is `camelCase` with `Future`/`Stream`. Events are
`on("name")` in TS, `Stream`s in Dart, C# events pumped by `Poll()`.

### `session` — who I am, and what time it is

| member                         | does                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signIn()`                     | starts the auth redirect (browser) or opens the system browser and waits for the app's redirect (mobile); resolves with the token, `userId`, `expiresAt` |
| `fromToken(jwt)`               | adopts a token obtained elsewhere (tests, a launcher)                                                                                                    |
| `userId`, `expiresAt`, `token` | identity; `token` exists for the wire packages and is the one thing a game should never persist on the web                                               |
| `now()`                        | platform time: `GET /time` once, then the local monotonic clock plus the measured offset; never the device wall clock                                    |
| event `expiring`               | fired once at `exp − 10 min`; the only remedy is `signIn()` again (no refresh endpoint)                                                                  |
| event `signedOut`              | a 401 from any module (expired, channel disabled) — every module stops and the game shows the sign-in screen                                             |

Storage adapter: `{ load, store, clear }`; the web default is none, the
mobile default is the platform secure store (Keychain / Keystore via the
host app's plugin, injected — the kit is engine-free).

### `content` — what the team publishes to everyone

Read-only view over a `readScope: project` collection (`writeScope: team` or
`server`). `get<T>(key)`, `list<T>(prefix?)`, `subscribe(key, handler)`
(polling with the entry `ETag`, interval configurable, default 60 s). A
cached value is returned immediately and refreshed in the background; the
game never blocks on tuning data.

### `save` — the player's own record

Over a `readScope: user` + `writeScope: user` collection's `me` namespace.

| member                                 | does                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `load<T>(name)`                        | the value or `undefined`; keeps the version                                                                                                                     |
| `store(name, value, { merge? })`       | conditional write with the kept version; on 409 reloads and calls `merge(local, remote) → value` if given, else fails with `conflict` — never a blind overwrite |
| `update(name, fn, { merge? })`         | load → `fn(value)` → store, with the same conflict rule                                                                                                         |
| `counter(name).add(n, { min?, max? })` | atomic `incr` with the range guard — a wallet that cannot go negative in one step                                                                               |
| `claimOnce(name, ttl)`                 | `If-None-Match: *` + TTL: true the first time per window, false after — a daily reward with the server's clock                                                  |
| `remove(name)`                         |                                                                                                                                                                 |

Offline queue (mobile, opt-in): writes are queued while offline and replayed
in order on reconnect; a replayed write that conflicts runs `merge`.

### `room` — a private group with a host

Over the lobby party plus `event`/`say` with `scope:"party"|"user"`. The
lobby socket is the kit's; the game may still use `gamebase-client` for
`pos`/zone chat on the same socket.

| member                            | does                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `create()`                        | `party.create`; the creator is host                                                                           |
| `invite(userId)`                  | `party.invite`; `unknown_user` becomes the kit error `offline`                                                |
| event `invited(roomId, from)`     | with `accept()` / `decline()` on the event object                                                             |
| `leave()`                         |                                                                                                               |
| `members`, `host`, `isHost`, `id` | mirrored from the `party` frame; `host` is the party leader, always                                           |
| `send(name, payload)`             | `event scope:"party"`; `payload` ≤ 8 KB → `payload_too_large` before sending                                  |
| `whisper(userId, name, payload)`  | `event scope:"user"`                                                                                          |
| `on(name, handler)`               | game events, with `from`; the kit's own events use the reserved prefix `kit.` and are never delivered to `on` |
| event `memberJoined/Left/Online`  | from roster diffs                                                                                             |
| event `hostChanged(userId)`       | the leader seat passed (the gateway's rule: next member)                                                      |

**Host authority (by agreement).** The host is the party leader. The kit
standardises three things a host-authoritative game otherwise reinvents:

- `becomeHost(handler)`: called on the new host after `hostChanged` with
  `lastKnown` — the most recent state the kit saw from the previous host
  (below) — so the run continues from the last snapshot instead of ending.
- `state.publish(snapshot)` (host) / event `state(snapshot)` (members):
  a `kit.state` event the kit keeps a copy of on every member. Snapshot
  ≤ 8 KB; a larger game sends deltas through `send` and publishes a full
  snapshot at its own cadence.
- Resync: a member that (re)joins sends `kit.resync`; the host answers with
  the last published snapshot; the member sees it as `state`. Triggered
  automatically on reconnect and on `hostChanged`.

Ordering: the gateway never drops control frames and delivers one sender's
frames in order, but two senders' frames interleave freely. The kit stamps
every `send` with a per-sender sequence and drops a duplicate seen across a
reconnect; it does not reorder across senders — a game that needs a total
order gets it from the host (`turns` below is the turn-based case).

### `turns` — a deterministic turn log

Over `room`. For any game where the whole state is a function of an ordered
move list: chess, janggi, card games, word games.

```ts
const game = kit.turns.start<Move, State>({
  room,
  players: [a, b], // turn order; `room.members` by default
  initial: State,
  apply: (state, move, by) => State, // throws to reject a move
});
game.submit(move); // only on my turn, else `not_your_turn`
game.on("turn", ({ state, move, by, index }) => render(state));
game.on("mismatch", ({ index, by }) => showDesync()); // a peer's move failed `apply` here
game.finish(result); // both sides record it (see below)
```

- Every move travels as `kit.turn {index, move, by, hash}` with
  `hash = h(prevHash, index, by, move)`; a peer whose `apply` throws, or whose
  hash differs, raises `mismatch` and freezes — the game decides whether to
  resign, restart or ignore. Nothing is arbitrated.
- Reconnect: `kit.turns.log` request → any peer replies with the full log;
  the kit replays it through `apply`. With `persist: true` the log is also
  written to `save` under `turns:{roomId}` with a TTL, so a closed tab
  resumes without a peer.
- Clocks are local and informational (`elapsed` per player); the kit does
  not enforce time controls.
- `finish(result)` records the result the game names to every configured
  sink (`board`, `save`); each player writes their own copy, and the docs say
  so.

### `board` — leaderboards

Over `/lb/*`. `kit.board("weekly")` by alias.

| member                           | does                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `submit(score, meta?)`           | `PUT …/scores/me`; resolves with `[{period, rank, score, endsAt}]`; on a `submit: server` board → `server_only` |
| `top(period, { limit, offset })` |                                                                                                                 |
| `me(period)`                     | `{score, rank, total}` or `undefined`                                                                           |
| `around(period, span)`           | `me` then `top` with `offset = rank − span − 1`, clamped                                                        |
| `periods`, `rule`, `order`       | from `GET /lb/{board}`                                                                                          |

`endsAt` is a platform timestamp; the countdown uses `session.now()`.

### `mail` — an inbox

Over a `readScope: user` collection whose `writeScope` is `server` (the
game's server or the console sends) or `project` (players send, stamped by
the platform).

| member                      | does                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list()`                    | letters: `{id, from, at, value, expiresAt}` newest first; `from` is `"server"`, `"team"` or a userId                                              |
| `read(id)`                  |                                                                                                                                                   |
| `claim(id)`                 | read then delete with `If-Match`; resolves with the letter exactly once, `already_claimed` on the race — the game applies the reward it describes |
| `remove(id)`                |                                                                                                                                                   |
| `send(to, value, { ttl? })` | player mail (`writeScope: project` only): create-only with a kit-minted id; `inbox_full` when the recipient's cap is hit                          |
| event `arrived(letter)`     | polling with `?prefix` and a high-water mark; interval configurable, default 30 s, paused in background                                           |

### `friends` — relations, profiles, presence

Over `/social/*` and the gateway's `/presence`.

| member                                                                | does                                                                                                            |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `list()`                                                              | `[{userId, profile, online}]` — relations from state, presence from the gateway in one batch, joined by the kit |
| `requests()`                                                          | incoming and outgoing                                                                                           |
| `request(userId)`, `accept`, `decline`, `remove`, `block`, `unblock`  |                                                                                                                 |
| `profile.me()`, `profile.set({displayName, avatar})`, `profiles(ids)` | batch of ≤ 50 with a cache                                                                                      |
| `invite(userId)`                                                      | sugar: `room.invite` if online, else `offline`                                                                  |
| event `requested(from)`                                               | polling, same policy as `mail`                                                                                  |

### `matchmaking` — strangers into a room

Over the match socket, then `room`.

- `find({ timeoutMs? })` → `{ matchId, members }`; `cancel()` closes the
  socket. Requires the lobby socket to be up (`lobby_required`), because the
  next step needs invites to reach online users.
- With a callback-less match channel the kit forms the room itself: the
  member with the lowest `userId` runs `room.create` and invites the rest;
  the others auto-accept an invite **only** from a matched member within
  30 s. `find` resolves once every member is in the room (or with the
  partial roster after the window, `partial: true`). With a callback channel
  the kit hands back `result` verbatim and forms no room.

## Errors

One type per language — `KitError { module, code, retryable, cause? }` —
and one code table shared by all three repositories. Wire errors are mapped,
never surfaced by HTTP status or close code:

| code                | from                                      | retryable |
| ------------------- | ----------------------------------------- | --------- |
| `not_configured`    | module used without its config block      | no        |
| `signed_out`        | any 401                                   | no        |
| `offline`           | invite/whisper to a user without a socket | yes       |
| `conflict`          | save version lost and no `merge`          | yes       |
| `out_of_range`      | counter guard                             | no        |
| `payload_too_large` | room/turns payload > 8 KB                 | no        |
| `not_your_turn`     | turns                                     | no        |
| `mismatch`          | turns hash/apply divergence               | no        |
| `server_only`       | board `submit: server`                    | no        |
| `already_claimed`   | mail claim race                           | no        |
| `inbox_full`        | mail send                                 | yes       |
| `lobby_required`    | matchmaking without a lobby socket        | no        |
| `unavailable`       | 5xx, network                              | yes       |
| `rate_limited`      | 429 / gateway `rate_limited`              | yes       |

## Scenarios every repository proves

1. `session`: `expiring` fires once; a 401 anywhere emits `signedOut` and
   stops every module; `now()` ignores a device clock set a day off.
2. `save`: two clients writing one key — the loser gets `conflict` or the
   `merge` result, never a silent overwrite; `claimOnce` is true once per
   TTL window; `counter` refuses to cross `min`.
3. `room`: create → invite → accept → roster on both; host leaves → the next
   member gets `becomeHost` with the last snapshot; a member reconnects →
   receives `state` without the game doing anything; an 8 KB + 1 payload is
   refused locally.
4. `turns`: a full game replayed from the log gives the same final state on
   both sides; a tampered move produces `mismatch` on the peer; reconnect
   mid-game resumes at the right index.
5. `board`: submit on an `owner` board returns every configured period; on a
   `server` board → `server_only`; `around` at rank 1 clamps.
6. `mail`: two `claim` calls on one letter resolve exactly one; `arrived`
   fires once per letter across polls.
7. `friends`: request → accept produces the pair on both; a blocked user's
   request is invisible; `list` marks presence from the gateway.
8. `matchmaking`: callback-less match with 4 members ends with all four in
   one room; a member that never joins yields `partial`.

## Reference games (`yingyeothon/examples`)

- **chess** (web): `session` + `room` + `turns` + `board` — the serverless
  1:1 case.
- **four-dungeon** (web + Flutter): `session` + `room` with host authority +
  `save` + `mail` + `board` — the serverless co-op case, with the trust
  caveats printed on its title screen.

## Delivery

Server dependencies: `content`, `save`, `room`, `turns` work on today's
platform; `board` needs `todo/36`, `mail`'s stamp and `counter`'s range need
`todo/37`, `matchmaking`'s room forming needs `todo/38`, `friends` needs
`todo/39`. **All four shipped on dev and prod by 2026-09-10**
(`docs/leaderboard.md`, `docs/kvstore.md` _Mail_, `docs/decisions.md` #8,
`docs/social.md`), so every wave is unblocked on the server side. One
exception, and it is not a deploy: `friends`'s online dots call the gateway's
`GET /presence`, which is in the merged image and answers only after the
gateway container is recreated — a restart that disconnects every player, so it
waits for a quiet day rather than for code. The kit therefore lands in three waves, each shipped in all three
repositories before the next: **A** session/content/save/room/turns,
**B** board/mail, **C** friends/matchmaking. Per-repository checklists:
`todo/40-game-kit.md` here, mirrored as each repository's handover.
