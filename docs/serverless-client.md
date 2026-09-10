# Building a game on the platform without a server

Assessment of 2026-09-08: what a web or mobile client developer can build with
yyt alone — auth, sites/catalog, assets, kv, the gateway — writing no server
code at all. The settled consequences (leaderboard, kv `server` scope,
callback-less match, social) are in `docs/decisions.md` _Serverless clients_;
this page keeps the reasoning and the capability matrix. **All four have
shipped since**: the callback-less match (2026-09-08), the kv `server` scope and
mail (2026-09-09), the leaderboard (2026-09-10, `docs/leaderboard.md`) and
`/social/*` (2026-09-10, `docs/social.md` — the gateway's `GET /presence`
lands with its next container restart). Where a bullet below says "there is no
…", check that list first.

## Two reference cases

**1:1 chess / janggi.** Feasible today, low risk.

- Sign-in: auth `GET /c/{ch}/start?redirect=` → `302 {redirect}#token=`; the
  site URL (`https://g.yyt.life/{slug}/`) goes into the auth channel's
  `redirectAllowlist`.
- Matching: friends through `party.invite` on a `lobby` channel; random
  matching by claiming a "seat" key in a `project/project` kv collection with
  `If-None-Match: *` (atomic, one winner), then inviting the seat's owner.
  (The match service needs a callback server — see below.)
- Play: each move is an `event` with `scope:"party"`; both clients validate
  every move, so an illegal move is detected by the opponent immediately.
  Nothing on the wire needs an authority. The party survives a reconnect
  (30 min sliding TTL); a move list kept in the player's own kv namespace
  recovers a closed tab.
- What stays unverifiable: the **result**. Each player writes their own
  record, so "I won" cannot be checked, and time controls run on each
  player's clock. Fine between friends; not fine under a ranking.

**4-player dungeon MORPG, host-authoritative.** Feasible with the changes
below, but the trust model is the limit, not the API.

- Town = `lobby` `pos`/`say`; dungeon = the host client broadcasts state with
  `event scope:"party"` every 200 ms, members send inputs. 8 KB payload,
  32 KB outbound frame and the channel `rateLimit` are enough for four.
- **Do not use a zone as the dungeon.** `gateway/README.md`: zones are not
  private — anyone can announce into `dungeon:{partyId}` and receive its
  snapshot. Only party scope is member-only.
- The host decides monster HP, drops and results, so the host can forge all
  of it, and a host that leaves ends the run (host migration is the client's
  work). The RNG is the host's.
- Rewards: four clients each write their own reward to their own kv
  namespace; nothing checks it. A `readScope: project` profile or ranking in
  kv is writable by its owner at will.

## What works today with no server

| need                            | platform piece                                                 | note                                                               |
| ------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| sign-in                         | auth redirect flow, JWT 24 h by default                        | no refresh; `redirectAllowlist` must list the site                 |
| web client hosting              | `site` (`g.yyt.life/{slug}/`), runtime config in `config.json` | one shared origin for every team (below)                           |
| mobile client distribution      | catalog (APK)                                                  |                                                                    |
| static game data (maps, tables) | asset bundle on the CDN, or kv `readScope: project`            | `/s/{ownerId}` (doc) is per-player, not for maps                   |
| rooms, invites, room messages   | `lobby` party + `event`/`say` with `scope:"party"\|"user"`     | JWT only, no apiKey                                                |
| per-player progress             | kv `writeScope: user`, written with the player's JWT           | `If-Match`, `If-None-Match: *`, `PATCH {incr}` all client-callable |
| one-shot claims (daily reward)  | kv `If-None-Match: *` + `?ttl=`                                | server-clock expiry, so the client's clock does not matter         |

## What does not work without a server

- **A client cannot create a topic.** `POST /t` takes the channel apiKey only,
  and the topic HTTP stack has no CORS (only the state stack enables it). The
  "host announces a fresh topic URL" design is therefore impossible, and the
  `lobby` party is the replacement — `docs/decisions.md` already calls a
  chat-only lobby "a better topic". Adding client-created topics was
  considered and **rejected** (2026-09-08): it would duplicate the party.
- ~~**The match service** posts to `callbackUrl` and forwards the 2xx body;
  no callback receiver, no match.~~ **Fixed 2026-09-08** by the callback-less
  mode (`docs/decisions.md` #8, `todo/38`): a match channel created without a
  `callbackUrl` posts nowhere and hands every member the roster instead —
  `{"type":"matched", matchId, partial, result: null, members:[{userId}]}`.
  The recipe the platform documents: the member with the **lowest `userId`**
  runs `party.create` on the game's lobby channel and invites the others by
  `userId`. One rule, no vote: every client derives the same host from the same
  roster, and a `userId` is 32 lowercase hex, so every language's string
  comparison agrees. (`members` also arrives in the same ticket order on every
  socket, so `members[0]` — the oldest waiter — is an equally deterministic
  rule; pick one and keep it.)

  Four conditions the platform does **not** check, and each fails quietly:

  - **The lobby channel's `partySizeMax` must be at least the match channel's
    `partySize`.** `partySizeMax` defaults to 4 and `partySize` goes to 16, so a
    party of 6 formed by match gets `party_full` on the host's fourth invite
    while the match side logs a clean success.
  - **Both channels must point at the same auth channel.** `members[].userId`
    is the `sub` the _match_ channel's auth channel derived; the lobby resolves
    the id its _own_ auth channel knows. Two auth channels and every invite is
    `unknown_user`.
  - **Everyone must already hold a lobby socket** when the match lands: an
    invite to an offline user is `unknown_user` too. And a player still in a
    party from the previous match gets `in_party` on `party.create` — leave the
    old party before queueing again.
  - **A member whose socket dies takes the party with it.** The stack posts
    `matched` and forgets; there is no `failed` frame afterwards and the ticket
    is already gone. A client that gets `unknown_user` on an invite, or that
    receives no invite within a few seconds of `matched`, has to re-queue. In
    the callback mode the game server at least held the roster and could
    compensate; here nobody does.

- **Doc writes** (`PUT /s/{ownerId}`) are apiKey-only; a client persists
  through kv, not doc.
- **Nobody vouches for a value.** Every kv scope a player can reach is one
  the player can write. Announcements, mail with rewards, and server-set
  currency need a scope a JWT cannot write — the kv `server` scope.
- **Rankings** in kv are key-ordered lists a player fills in; there is no
  sorted read and no rank. Hence the leaderboard resource — **shipped
  2026-09-10**, `docs/leaderboard.md`: `/lb/*` on the state stack, a board per
  project with `submit: server | owner`, `alltime`/`daily`/`weekly` buckets in
  `Asia/Seoul` and `rank = 1 + count(better)`. A serverless game runs
  `submit: owner` and accepts that its scores are trusted.
- ~~**Friends** need a relation two players both approve; kv has no
  two-owner entry.~~ **Fixed 2026-09-10** (`docs/decisions.md` #9,
  `todo/39`, `docs/social.md`): `/social/*` on the state stack, scoped to the
  auth channel. The recipe a client follows:

  1. `PUT /social/me/profile {displayName, avatar?}` once per player. A
     profile is what admits a player to the graph — both ends of a relation
     need one, so a client that skips this gets `409 profile_required` on its
     first request and `404` on every request **sent to** it.
  2. `POST /social/requests {to}` with a friend's `userId` (from the lobby
     roster, the match `members` frame, or the game's own invite code).
     `201` for a new request, `200` when nothing moved, and `state: "friends"`
     when the other player had already asked — mutual requests settle without
     an accept.
  3. The recipient polls `GET /social/requests` and answers `accept` or
     `decline`. **A decline is silent**: the sender goes on seeing a pending
     request until it expires 30 days later, so do not build UI that promises
     an answer.
  4. `GET /social/friends` returns the graph with display names joined in;
     hand its `userId`s to the gateway's
     `GET /presence?channel={lobbyId}&users=…` (≤ 50 per call) for the
     online dots, then invite the online ones with `party.invite`. Poll it on
     the order of tens of seconds, never per frame: a session key changes
     slowly, and behind the gateway's proxy every client of a stage may share
     one rate bucket.

  Three preconditions the routes cannot check for you: the lobby channel and
  the social graph must sit behind the **same auth channel** (an id derived
  under another channel's salt addresses nothing), presence is stale by up to
  15 minutes after an ungraceful gateway stop, and a `displayName` is **not
  unique** — render the `userId` beside it wherever a mistake matters. And
  presence is **not** block-aware: the gateway has no view of the social
  graph, so blocking somebody does not hide you from their friends list.

- No trusted clock (`GET /time`), no trusted RNG, no push notifications.

## The kit module for each recipe

Every recipe above is a paragraph each game re-implements from scratch: the
existing client libraries are _wire_ packages that map onto a server surface
(`gamebase-client`, `kvstore-client`, `auth-client`), so the recipe — the
`If-Match` loop, the 409 retry, "the lowest `userId` creates the party" — has
lived in the games. The game kit (`docs/game-kit-design.md`, `todo/40`) is that
list turned into named modules, identical in TypeScript, C# and Dart, so a game
can say `save.store(...)` where this page spells out a paragraph. **The
platform pieces do not change** — the kit is a client-side shape over the same
routes, and a game that wants the raw route still has it.

| kit module    | the recipe here                                   | platform pieces it wraps                                                         |
| ------------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `session`     | sign-in, "no trusted clock"                       | auth `GET /c/{ch}/start?provider=&redirect=`, the JWT, state `GET /time`         |
| `content`     | static game data the team publishes               | kv `readScope: project`, read-only, polled by entry `ETag`                       |
| `save`        | per-player progress, one-shot claims              | kv `writeScope: user` with `If-Match` / `If-None-Match: *` / `PATCH {incr}`      |
| `room`        | rooms, invites, party play, host authority        | gateway `lobby` party, `event`/`say` with `scope: "party" \| "user"`             |
| `turns`       | chess: one move per turn, both validate           | the same party events plus a hash chain the kit keeps                            |
| `board`       | rankings                                          | state `/lb/*` (`docs/leaderboard.md`)                                            |
| `mail`        | "nobody vouches for a value", rewards             | kv `server` scope and player mail (`docs/kvstore.md`)                            |
| `friends`     | the `/social/*` recipe above, online dots         | state `/social/*` plus gateway `GET /presence` (`docs/social.md`)                |
| `matchmaking` | the callback-less match recipe and its four traps | match channel without a `callbackUrl`, then `room.create` on the lowest `userId` |

Asset bundles on the CDN and the `site` that hosts the page have no module:
they are what the game is delivered _as_, not something it calls. Nor does the
**config block** that feeds every module — `GET /projects/{prj}/kit-config` (or
`yyt project kit-config`) prints the project's channel ids, its collection and
board names and the stage's own hosts as one public JSON block to paste into
the game. It carries no secret by construction, which is what lets it live in
the game's repository.

## What is risky

- **Shared origin.** Every site shares `g.yyt.life`: another site can read a
  page's JWT through a same-origin frame and then write that player's kv. The
  standing rule (never store the token) is a real requirement here, and a
  24 h token in memory is still exposed for its lifetime. Native mobile
  clients do not have this problem; per-site origins are the fix
  (`todo/34-backlog.md`).
- **`writeScope: project`** lets any player overwrite any key; use it only
  for things a player may legitimately clobber (a seat claim), never for
  shared state.
- **Host authority** in real-time co-op: cheating and host loss are the
  game's problem. A quorum-attested write (N members submit an identical
  value within T seconds) would close the single-forger case and was
  proposed; the owner deferred it on 2026-09-08 (`todo/34-backlog.md`) —
  contest games accept trust.

## Why the two cases differ

| axis               | chess / janggi           | 4-player dungeon        |
| ------------------ | ------------------------ | ----------------------- |
| authority          | symmetric, both validate | one host                |
| randomness         | none                     | host-local, forgeable   |
| state size / rate  | one move per turn        | snapshot at 5 Hz        |
| host leaves        | party survives, resume   | run ends                |
| what can be forged | only the recorded result | the run and the result  |
| shared writes      | one seat claim           | rankings, rewards, many |

The dividing line is **verification symmetry**: a deterministic turn-based
game needs no authority because every peer checks every move; a real-time
co-op game hands authority to one peer and must trust it.
