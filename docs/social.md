# Social (`/social/*`)

Design of record: `docs/decisions.md` _Serverless clients_ #9–#10 (2026-09-08, revised 2026-09-10 by four owner decisions taken after three plan reviews). This page is the working reference between that contract and the code: who may do what, which transition a state machine allows, and what each surface owes. Route-level detail is in `services/state/README.md` (_Social routes_) and `gateway/README.md` (_Presence_). Execution record: `todo/39`.

Social is **scoped to the auth channel**, like documents — not to the project, like kv and leaderboards. A project running two auth channels therefore has two disjoint friend graphs over one kv collection, which is the right shape: an owner id is derived from the channel's salt and means nothing outside it.

Two tables (`m0019_social`): `social_profiles` (`(channel, owner)`) and `social_relations` (`(channel, from, to, state)`), neither with a foreign key to `channels` — a cascade would run inside the purge's single `DELETE FROM channels` against a 5 s `max_statement_time` on a host five stacks share, so the console deletes these rows explicitly and in bounded batches, exactly as it does for kv entries and scores.

## Principals

| principal | credential                                                 | rights                                                                                                                                                                     |
| --------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner`   | the auth channel JWT (`sub` = a 32-hex player id)          | its own profile; its own relations; reads any profile of the channel                                                                                                       |
| `server`  | the auth channel's doc apiKey (`yds.{channelId}.{random}`) | reads profiles and any player's friends; writes and deletes **profiles**; deletes relations; **never creates** a relation. It does not read a player's inbox or block list |
| `team`    | console session / `yyt_` token                             | a profile **count** on the channel's detail card, and the channel delete that takes it all                                                                                 |

- A server key that could _make_ a friendship could forge mutual consent, which is the whole content of one. It can only remove — which is what keeps "delete the channel" from being the only answer to an abuse report, since deleting a channel also destroys every player's documents, kv rows and scores.
- The console has **no** route that reads a profile or a relation, no SPA page and no CLI verb. Personal data the platform holds for a game is the game's; an operator who could browse it would be a reason not to store it.
- A token whose `sub` is not a player id (a game may choose its own subjects) is a 403 that says so: both ends of a relation must be addressable.

## A profile admits a player to the graph

A relation may only name players who **both** hold a profile (owner decision 2026-09-10) — **except a block**, which is protective and may name any player id, because the id of somebody worth blocking usually comes from a lobby roster rather than from the graph. The bound the rule exists for survives that exception: the _blocker_ needs a profile, so blocks are at most 500 per profiled player. Three things follow:

1. `social_relations` inherits a ceiling. Without it a player could spend its hundred outgoing slots on invented 32-hex ids nobody can ever accept or decline, and the table would have no bound at all — a problem for the channel purge rather than for storage, because a channel that cannot be drained inside the sweep's budget leaves rows that outlive the id that gave them meaning.
2. `DELETE /social/me/profile` is a real answer to "delete my data": it takes the owner's relations in both directions with it — **except somebody else's block of them**. That row is the blocker's, not theirs, and without the exception deleting and recreating a profile (the id is derived, so it comes back the same) would be the two calls that lift every block against you, silently, since a block is never announced.
3. The 404 below stops being a proof.

`displayName` is 1–32 characters as sent (trimmed, and nothing else normalised), refusing `\p{Cc}`, `\p{Cf}` and U+2028/2029 — a newline forges a row in an operator's table, a bidi override reorders one, a zero-width joiner makes two different names look identical — and a run of five or more combining marks. It is **not unique**: two players may share a name, so a client renders the owner id beside it wherever a mistake matters (a trade, an invite, a kick).

`avatar` is ≤ 64 characters of `^[A-Za-z0-9][A-Za-z0-9._-]{0,31}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,31}){0,3}$` — an id or a path into the game's own asset table, never a URL. Opaque means the platform never resolves or interprets it, not that it must accept any string: a value with a `:` or a leading `/` is a scheme or a protocol-relative URL, and a client that renders one in an `<img src>` hands every viewer's address to whoever picked the name. A `PUT` replaces the whole profile, so an absent `avatar` clears it, and a `PUT` whose values are identical leaves `updatedAt` alone.

## The state machine

Four states, one row per direction. A friendship is **two** rows written in one transaction; a block and a request are one.

| from → to   | means                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------- |
| `requested` | a live request; in the recipient's inbox, charged to both pending caps                      |
| `dropped`   | a request the recipient declined; out of their inbox, still charged to the **sender's** cap |
| `friends`   | half of a friendship; the other row is the mirror                                           |
| `blocked`   | one-directional, and the only state a peer's write never touches                            |

- **A decline keeps the row.** Deleting it would hand the slot straight back and make request → decline → request free and infinite (the console's join→withdraw loop restated, `rules/security.md`). The sender is not told: their own list renders a `dropped` row exactly like a pending one, and a re-request answers exactly what a pending one answers and writes nothing — a refreshed `updatedAt` would push the expiry out for ever. The one place the two differ is `DELETE /social/requests/{ownerId}`, which refuses a `dropped` row because withdrawing it would clear the cooldown; that residual is the price of the cooldown and is deliberate.
- **Mutual requests settle immediately.** Two players who request each other become friends without an accept: sending a request _is_ the consent, and two `requested` rows facing each other is a state no route resolves. That path enforces both friend caps, like `accept` does — a cap enforced on one path and not the other is not a cap.
- **A block is the only state a peer's write leaves alone.** `PUT /social/blocks/{o}` drops the peer's row when it carried a friendship or a request, and never when it is their own block of the caller: deleting that would silently revoke somebody else's block, and they would never be told.
- **A block cannot clear a cooldown either.** A block replaces the caller's own `dropped` row in place, so without care block → unblock → request would be the four calls that hand the sender their slot back and put them straight into the recipient's inbox. The row carries a `cooldown_until` the block preserves and the unblock **restores** — an unblock puts a live cooldown back as `dropped`, with the original expiry, and only deletes the row when there was none.
- **Unblocking never restores a friendship** (only a cooldown), and a half friendship self-heals: a request between two players where either row says `friends` writes the missing mirror rather than a new request.
- Every transition locks the pair in a **canonical order** (`from`/`to` sorted) and re-reads its precondition **inside** the transaction. Without the order, two players acting on each other deadlock into a 503; without the re-read, a block that lands mid-accept is silently undone.

Caps per player: 200 friends, 100 outgoing requests (`requested` + `dropped`), 100 incoming, 500 blocks; 10,000 profiles per channel. Refusals name themselves in `details.reason`, and those strings are a cross-language contract (`docs/decisions.md` _Game kit_ #4): `profile_required`, `blocked`, `friends_full`, `peer_friends_full`, `pending_full`, `peer_pending_full`, `blocks_full`, `channel_full` — all 409 — plus the 404 below.

One state the machine can reach and not leave: two players who have each declined the other hold a `dropped` row in both directions, and each is shown a pending outgoing request the other will never see, until both expire. That is what two silent declines look like from the inside, and it is not repaired on purpose — the alternative is telling each of them that the other said no.

## What the 404 does and does not hide

`POST /social/requests` answers **404** when the target blocked the caller. That is the decision's own sentence, kept over the reviews' objection that it is an oracle — and what repairs it is the profile rule: a target with no profile answers the same 404, so the code is shared by "blocked you", "never played" and "no such id".

It is **not** proof, and the platform does not claim more. A caller who already knows a target has a profile can still infer a block. A block bounds harassment; it is not anonymity. For the same reason `GET /social/profiles?ids=` does **not** hide a blocker's profile: omitting a row the caller has seen before would be a stronger and passive oracle than the one being avoided, batchable fifty at a time and re-checkable for ever.

One more composition to state plainly, because it is not this route's fault and is still this route's problem: a channel's players can already obtain bulk owner-id lists from `GET /kv/{col}/entries` on a `readScope: project` + `writeScope: user` collection and from `GET /lb/{board}/top`. Feed those ids here fifty at a time and the profile route is a directory. Profiles are public within their channel by decision; what stops that from being a re-identification step is the per-channel salt, and a channel created before 2026-09-09 has none.

## Expiry

A request expires 30 days after its last write, pending or dropped — an inbox with no expiry can be wedged for a channel's lifetime by throwaway accounts, and a decline that never expired would be a permanent ban nobody chose. Friendships and blocks never expire; they end when a player unmakes them, deletes their profile, or the channel dies.

The daily social sweep has two phases and its own budget: first the profiles and relations of the auth channels that day's expiry finished with (**work lost if skipped** — nothing names those rows once the channel row is gone, so it logs at `error`), then the stale requests, one indexed `DELETE` per state over `(state, updated_at)`. No cursor: the second phase is not a walk.

The channel phase is a bound, not a promise. 10,000 inline at the soft delete plus 20 × 1,000 on each of the two sweep days is ~50,000 rows, and a channel near the profile cap can hold far more; what is left is orphaned, and the `error` line is the only signal. A channel that large is a hackathon that has become a product, and draining it is a bounded manual delete in the ops repo. The bound is the same shape the kv and leaderboard sweeps accept; only the worst case is bigger.

## Presence is the gateway's

The state stack has no Redis and gains none. `GET /presence?channel={lobbyId}&users=a,b,…` on the gateway answers the online state of up to 50 player ids to the bearer of any member's JWT on that lobby's auth channel, and the client joins it to its own friend list. Two things a client must know:

- It is a **widening**, not a restatement of `/parties`: a party roster is answered only to a member of that party, while this answers for any id the caller names. It confirms, it never discovers — malformed ids are a 400, and "offline" and "no such player" are the same answer.
- **It is not block-aware, and it structurally cannot be**: the gateway has no MariaDB and the state stack has no Redis, which is the whole reason presence lives where it does. So a player who was blocked keeps a working presence feed on the player who blocked them, for any id they already hold. A block bounds what the social graph will do for you, not what the lobby already discloses.
- `online` means a session key exists, and that key carries a 15-minute TTL refreshed on traffic. After an ungraceful stop — a crash, or the container recreate a gateway release performs — a departed player reads as online until it expires. Presence is a hint for a friends list, never an input to an authorization decision.

The ids have to come from the **same** auth channel the lobby names; that is what makes an id from `/social/friends` addressable there at all.

## Cost per request

The state stack runs with one database connection, `timeout: 10` and no channel cache — every request already pays one uncached `SELECT` to resolve its bearer, by rule (a channel row carries the signing secret and the doc apiKey, and `rules/data.md` forbids caching one). On top of that:

| route                   | statements                                                          |
| ----------------------- | ------------------------------------------------------------------- |
| `GET /social/friends`   | 2 (relations by the primary key, then one `IN` over the profiles)   |
| `GET /social/requests`  | 3 (incoming, outgoing, one `IN` over the union of both)             |
| `POST /social/requests` | 5 in one transaction (lock, pair, profiles, caps, incoming) + write |
| `accept` / `block`      | 3–4 in one transaction                                              |
| `withdraw` / `unfriend` | 2–3 in one transaction                                              |

The profile join is deliberate: pushing it to the client would cost four `GET /social/profiles?ids=` round trips, and each of those pays its own channel `SELECT` and its own Lambda invocation against `reservedConcurrency: 6`. There is no per-caller rate limit — the state stack has none, and the stage throttle (20 rps, burst 40, shared by every channel) is the only bound, the same one `docs/decisions.md` #6 accepted for kv mail. What keeps that from being a hole is that the stored state absorbs the loops: a decline costs the sender a slot for 30 days, a re-request writes nothing, and an unchanged profile `PUT` does not touch the row.

## Surfaces

- **Social API** (`services/state/src/social.ts`): `GET|PUT|DELETE /social/me/profile`, `GET /social/profiles?ids=` (≤ 50), `GET /social/friends`, `GET /social/requests`, `GET /social/blocks`, `POST /social/requests {to}`, `POST /social/requests/{ownerId}/accept|decline`, `DELETE /social/requests/{ownerId}`, `DELETE /social/friends/{ownerId}`, `PUT|DELETE /social/blocks/{ownerId}`; server only: `GET /social/u/{ownerId}/friends`, `PUT|DELETE /social/u/{ownerId}/profile`, `DELETE /social/u/{ownerId}/relations[/{other}]`.
- **Shared rules** (`packages/console-db/src/social.ts`): the caps, both grammars, the canonical pair order and every transition planner. The Prisma repository and the in-memory fake share the planners, so only storage differs, and a contract test pins both against MariaDB.
- **Console** (`services/console/src/social.ts`): `deleteChannelSocial` at the channel's soft delete, `runSocialSweep` daily, and a `profiles` count on `GET /channels/{id}/doc-key`. There is deliberately **no** relation count: both would be a `COUNT(*)` on a read that backs a page, and only the profile count has a ceiling — an unbounded one on a shared host with a 5 s statement limit is what `m0018` exists to remember.
- **SPA / CLI**: the same count, on the channel's _Document storage_ card and in `yyt channel doc-key`. Nothing else.
- **Gateway** (`gateway/internal/server/server.go`): `GET /presence`, its own per-address bucket, `presenceReads`/`presenceRejected` on `/metrics`.
- **Smoke** (`scripts/smoke/social.mjs`): a full round trip on dev that spends all four granted privileges, because the state account's grant is a hard gate — without it every route here answers 503.
