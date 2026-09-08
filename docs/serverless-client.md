# Building a game on the platform without a server

Assessment of 2026-09-08: what a web or mobile client developer can build with
yyt alone — auth, sites/catalog, assets, kv, the gateway — writing no server
code at all. The settled consequences (leaderboard, kv `server` scope,
callback-less match, social) are in `docs/decisions.md` _Serverless clients_;
this page keeps the reasoning and the capability matrix.

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
- **The match service** posts to `callbackUrl` and forwards the 2xx body;
  no callback receiver, no match. Fixed by the callback-less mode.
- **Doc writes** (`PUT /s/{ownerId}`) are apiKey-only; a client persists
  through kv, not doc.
- **Nobody vouches for a value.** Every kv scope a player can reach is one
  the player can write. Announcements, mail with rewards, and server-set
  currency need a scope a JWT cannot write — the kv `server` scope.
- **Rankings** in kv are key-ordered lists a player fills in; there is no
  sorted read and no rank. Hence the leaderboard resource.
- **Friends** need a relation two players both approve; kv has no
  two-owner entry. Hence `/social/*`.
- No trusted clock (`GET /time`), no trusted RNG, no push notifications.

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
