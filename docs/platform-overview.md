# YYT platform — overview for comparison

A compact description of what this platform is, what it deliberately is not, and the
numbers that bind it. It exists to be held next to another platform — a serverless
application backend, a game backend, or a contest-operations tool — so that a difference
can be judged as a **position** (chosen, and defended), a **deferral** (wanted, not yet
built) or a **gap** (missing, and it costs something).

Start at §3; §4–§7 are the backing detail for its rows.

It is a summary, not a spec. Every claim has a longer source: `docs/decisions.md` (settled
decisions, the contract), `rules/*.md` (engineering rules) and the design records listed
in §9. Where this file and `docs/decisions.md` disagree, `docs/decisions.md` wins.

**Status vocabulary**, used throughout: **live** = deployed on `dev` and `prod`;
**merged** = in `main`, not yet running; **designed** = decided and documented, not built.
Unmarked means live.

## 1. What it is for

Three products share one code base because they share one audience: the Yingyeothon
hackathon.

1. **A game backend** — the parts of a multiplayer game that are the same in every game
   (sign-in, rooms, matchmaking, saves, rankings, friends), so a team spends its contest
   day on game logic.
2. **A distribution channel** — where the build goes: an APK catalog with an installer
   app, static web hosting, and an immutable asset CDN.
3. **A contest-operations console** — teams, projects, date-vote events, issues, and a
   gallery of what was built.

The design target is explicit and unusual: **a team builds a casual MORPG in a 7-hour
contest and spends 2–3 hours of it on the server.** Traffic is near zero on every other
day of the year, and one person operates the whole thing.

Four consequences run through everything below:

- **Cost floor over scale ceiling.** Idle cost dominates the bill, so the platform is
  Lambda plus one small self-hosted box, and the CloudWatch alarm budget is the account's
  free 10.
- **A participant's server is optional.** A team may deploy a Lambda that holds authority,
  or write no server at all and use only credentials a browser may hold
  (`docs/serverless-client.md`).
- **A participant's server, when it exists, runs in their own AWS account.** The platform
  issues scoped credentials and never hosts their code.
- **Trust is social.** A team is a team building one game together, not a tenancy
  boundary. Abuse is handled in person.

## 2. Shape at a glance

| Piece                      | Runtime                                       | Where                                                              | Holds                                            |
| -------------------------- | --------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| `auth`                     | Lambda (Node 22, arm64, ESM, SLS 4 + esbuild) | `auth.yyt.life`                                                    | OAuth → per-channel JWT                          |
| `console`                  | Lambda                                        | `console.yyt.life` (API at `/`, SPA at `/ui`, CloudFront in front) | schema owner, every management route             |
| `topic`                    | Lambda + API Gateway WebSocket                | `topic.yyt.life` (HTTP), `topic-ws.yyt.life` (sockets)             | short-lived broadcast rooms                      |
| `match`                    | Lambda + API Gateway WebSocket                | `match.yyt.life`                                                   | FIFO matchmaker                                  |
| `state`                    | Lambda                                        | `doc.yyt.life`                                                     | `/s` documents, `/kv`, `/lb`, `/social`, `/time` |
| realtime gateway           | **Go, one Docker container**                  | `gw.yyt.life`                                                      | `lobby` relay, `q` actor bridge, `/presence`     |
| asset CDN / site host      | S3 + CloudFront                               | `d.yyt.life`, `g.yyt.life`                                         | immutable game data; static web builds           |
| MariaDB + Redis (Valkey 8) | self-hosted, one box                          | private ops repo                                                   | all durable and all volatile state               |
| `yyt` CLI                  | Go single binary                              | GitHub Releases                                                    | every console API as subcommands                 |
| console app ("잉여톤")     | Flutter                                       | distributed through the catalog itself                             | installer + project issues, sites, channels      |

Two deployment classes, and the rule that sorts them: **anything that must hold a socket
runs as a container; everything else is a Lambda stack.** Region `ap-northeast-2`, stages
`dev` and `prod`. **One MariaDB database per stage**; **one Redis shared by both stages**,
partitioned by `{service}:{stage}:` key prefixes and per-service ACL users — which is why
the stage segment is load-bearing rather than decorative.

## 3. Comparison grid

The working surface. "Stance" says whether a difference from another platform is chosen,
deferred, or a real gap.

| Axis                     | Question to ask of any candidate                                       | YYT today                                                                                              | Stance   |
| ------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------- |
| Idle cost                | What does a month of zero traffic cost?                                | one small VM + per-request Lambda/CloudFront + free-tier alarms; no per-project floor                  | position |
| Time to first player     | From an approved account with an OAuth app registered, how long?       | ~37 min by the playbook (channels 10 + copy 5 + deploy 10 + wiring 2 + smoke 10)                       | position |
| Identity coverage        | Which sign-in methods? Guest/device identity? Linking? Refresh?        | GitHub + Google **through the team's own OAuth app**; no guest, no linking, no refresh                 | gap      |
| Server-optional          | Can a client-only team ship a complete game?                           | yes since 2026-09-08; the limit is trust, not API surface                                              | position |
| Where custom logic runs  | Who hosts the game server, and in what shape?                          | the team's own AWS account; the `q` path binds it to tslib's Redis actor protocol                      | position |
| Authority / forgery      | Who can forge a result?                                                | the game's Lambda, or the host client; nothing attests a client-only result                            | deferred |
| Realtime scale           | Concurrent players per room, per instance, in total?                   | one process, socket cap 64, **design ceiling ~10 players**                                             | position |
| Realtime contract        | Is view/ordering consistency specified, or emergent?                   | specified and model-checked (view invariant) in `gateway/README.md`                                    | position |
| Latency and geography    | Round trip to the relay; tick rate; how many regions?                  | one region (`ap-northeast-2`); lobby coalescing tick 200 ms default (50–2000)                          | position |
| Matchmaking model        | FIFO, skill-based, rule-based? Backfill? Party support?                | **FIFO only**, party 2–16, one timeout policy (`partial`/`fail`), no backfill                          | gap      |
| Storage model            | How many shapes, and does the platform read the values?                | four shapes + two purpose-built stores; values opaque and byte-exact                                   | position |
| Query model              | How do you find a row whose key you do not have?                       | **you cannot** — every store is primary-key addressed; one sorted read (leaderboard)                   | gap      |
| Change notification      | Does a write reach other clients without a relay?                      | **no listeners on any store**; the gateway relays but is not attached to storage                       | gap      |
| Concurrency control      | Optimistic, pessimistic, or last-write-wins?                           | conditional writes required where it matters (`If-Match`, `If-None-Match`, write-once)                 | position |
| Authorization grain      | Per-resource, per-role, per-scope?                                     | team membership; per-collection scopes; one per-member grant table (shows)                             | position |
| Multi-tenancy            | Can one tenant exhaust another?                                        | yes — participants share one Redis (`allkeys-lru`, no per-account quota)                               | deferred |
| Durability and recovery  | What is the RPO, and who restores it?                                  | one un-replicated box; **backup/restore lives in the private ops repo, not here**                      | gap      |
| Client SDK coverage      | Which languages? Engine plugins? Does the SDK mirror routes or intent? | TS/C#/Dart wire packages; a purpose-shaped kit is **designed**, unshipped; no engine plugin            | deferred |
| Distribution to devices  | Can the built artifact reach a phone and a browser?                    | APK catalog + self-updating installer app, static site host, asset CDN                                 | position |
| Contest: onboarding      | Can participants self-register and find their team?                    | sign-up is self-service but **`pending` until an admin approves**; join by exact name, no team listing | position |
| Contest: event lifecycle | Scheduling, date voting, a public page, revision history?              | date-vote events, lazily derived status, every edit a revision, admin early close                      | position |
| Contest: submissions     | Submission deadlines, judging, scoring, prizes?                        | a `show` gallery with entries, likes and comments; **no judging, scoring or prizes**                   | gap      |
| Accountability           | Is operator action logged and readable?                                | global audit log, admin-readable, a reason required for every override                                 | position |
| Ops surface              | How many alarms, dashboards and runbooks does one operator hold?       | 10 alarms, 1 liveness probe, 1 CDN cost guard, 1 daily digest, 1 contest playbook                      | position |
| Portability              | What happens if the platform disappears mid-contest?                   | the game's own logic is in the team's account; the wire contracts are published                        | position |

When comparing with a **general serverless backend**, expect it to win on managed
datastores, queries, change feeds, durability and auth providers, and to have nothing for
contest operations, device distribution or matchmaking. With a **game backend**, expect it
to win on scale, authoritative simulation, economy, analytics and engine SDKs, and to
assume a long-lived project rather than a 7-hour one. With a **contest platform**, expect
it to win on judging, deadlines and scheduling, and to have no runtime at all. The useful
comparison is therefore per capability, never per product.

## 4. Capability map

### Identity

- A **channel** is the unit of configuration and of blast radius. Kinds: `auth`, `topic`,
  `match`, `lobby`, `q`. Every non-auth channel names an `auth` channel in the same
  project.
- The team registers **their own OAuth app** (GitHub or Google) and the platform mints an
  HS256 JWT: `iss = yyt-auth/{channelId}`, `aud`, `sub = userId`, 24 h by default. A game
  verifies it locally with the channel secret (`docs/auth-game-contract.md`); tslib's
  `createJwtRequestAuthorizer` reads it unchanged. The redirect flow is fenced by a
  per-channel `redirectAllowlist`.
- `userId` is the first 32 hex of `HMAC-SHA256(userSalt, "{channelId}:{provider}:{providerUserId}")`,
  the salt random per auth channel and never leaving the platform. **No player PII is
  stored or claimed** (console members are a different matter: their GitHub login is
  stored). A channel whose stored secret holds no salt — one created before the salt
  shipped to that stage — keeps the older unsalted `sha256` derivation for ever, and its
  ids therefore stay reversible; re-deriving would orphan every row keyed by the id.
  `provider` is inside the hash, so a channel with two providers gives one human two
  identities. No account linking, no refresh token, no guest identity.
- Console identity is separate: GitHub OAuth only, roles `admin`/`member`/`pending`,
  session cookie for the SPA, `yyt_` bearer tokens (GitHub device flow) for the CLI.

### Realtime

| Surface           | Model                                                                     | Lifetime               | Frame limits                             |
| ----------------- | ------------------------------------------------------------------------- | ---------------------- | ---------------------------------------- |
| `topic`           | server-created room, fan-out to all including the sender, no history      | **≤ 20 min per topic** | 16 KB per message                        |
| `lobby` (gateway) | client-authoritative position relay + chat + party, zone and AOI filtered | channel expiry         | 16 KB inbound / 32 KB outbound           |
| `q` (gateway)     | bridge from client sockets to a tslib actor Lambda (Redis list ↔ pub/sub) | the actor's window     | same; outbound binary opt-in per message |

The gateway **routes scopes, not semantics**: `pos` to a zone, `say`/`event` to
zone/party/user, payloads unread. It applies exactly two checks of its own — a per-zone
`maxMoveDelta` on `pos` (`move_too_far`) and per-connection and per-address token buckets
— and nothing else. Zone changes are decided by the game's HTTP API, not by the relay.

Its one hard contract is the **view invariant**: a zone-scoped frame naming a peer always
arrives after the `snapshot`/`enter` that introduced it and before the `leave` that removed
it. Control frames are never dropped for room; a socket that cannot keep up is closed
(`4005 too_slow`) rather than silently desynced. Model-checked under `-race`.

Two HTTP reads sit beside the sockets: `GET /parties/{partyId}` (a member proving its own
roster, which a participant's Redis credential cannot read) and `GET /presence` (**merged**,
answering only once the container is recreated) — up to 50 ids, a hint for a friends list
and never an input to an authorization decision. `/presence` is a **widening**: it answers
for any id a valid JWT on that lobby's auth channel names, it is not block-aware, and
`online` means a session key exists, which survives an ungraceful stop for up to 15
minutes.

### Matchmaking

FIFO only. Connecting a socket _is_ submitting a ticket; reconnecting with the same
`userId` replaces it. Party size 2–16, `waitTimeoutSec` default 60,
`onTimeout: partial | fail`. The `members` roster (ticket order) is delivered in **both**
modes; the modes differ only in what else happens:

- **with `callbackUrl`** — the platform POSTs the party (HMAC-SHA256 signed with the
  channel apiKey) and forwards the 2xx JSON verbatim to every client, so a game server
  chooses the room;
- **without** — nothing is posted anywhere, and a client-only game elects a host
  deterministically from the roster (lowest `userId`) and forms a `lobby` party.

No skill rating, no rule expressions, no backfill into a running match.

### Storage

The platform generalises **storage shapes, never game logic**, and never interprets a
game's schema — it lives opaquely inside the value.

| Store           | Backing                                                                                                                                                                                              | Written by                                                                        | Read by                                                     | Guarantee                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------- |
| **asset**       | S3 + CDN, immutable; **live** bundles (one namespace, SHA-256-checked, optionally mutable files); files over 64 MiB in 32 MiB parts, resumable for a day; client-side encrypted bundles (`yyt-enc v1`, live on dev and prod 2026-09-29) | team (presign → commit)                                                           | anyone, unauthenticated (an encrypted bundle as ciphertext) | write-once per `(bundle, version, path)` |
| **doc** (`/s`)  | MariaDB, versioned JSON                                                                                                                                                                              | server apiKey only                                                                | its owner, or the server                                    | `If-Match` mandatory; 428/409            |
| **ephemeral**   | Redis, TTL mandatory                                                                                                                                                                                 | gateway; a `q` game's own Lambda in its prefix                                    | the same                                                    | survives a reconnect, not a logout       |
| **kv** (`/kv`)  | MariaDB, per collection                                                                                                                                                                              | by scope                                                                          | by scope                                                    | optional CAS, TTL, AES-256-GCM           |
| **leaderboard** | MariaDB, per board                                                                                                                                                                                   | `submit: server \| owner`                                                         | any credential of the project                               | platform-computed periods, bounded rank  |
| **social**      | MariaDB, per auth channel                                                                                                                                                                            | players; a server key may write a profile and delete, **never create a relation** | players                                                     | two-row transitions in canonical order   |

Cross-cutting: a value is **stored as sent, byte for byte** — the request is parsed only
to prove it is JSON, because `JSON.stringify(JSON.parse(x))` loses integers past 2^53,
duplicate keys and key order. Every cap is **refused, not trimmed**. No store has a
secondary index, a filter, a join, or a change listener.

`kv` scopes are the platform's finest-grained authorization: `readScope`/`writeScope` each
one of `team | server | project | user`; a collection is per-owner when either is `user`.
That grid expresses announcements (`project`/`server`), a player's own progress
(`user`/`user`), telemetry (`server`/`user`) and player-to-player mail (`user`/`project`:
create-only, keys prefixed with the sender's id, both ends capped, the sender stamped by
the platform).

**Social** is profiles + friend requests (30-day TTL, decline cooldown) + blocks, scoped
to one auth channel. `GET /time` — the platform clock, the only unauthenticated route —
is what makes a client-only one-shot claim (a daily reward) independent of the device
clock.

**A browser reaches the state stack and nothing else**: only that stack sets CORS, with
`Access-Control-Expose-Headers: ETag` so a client can read the version it must send back.
The topic HTTP API has no CORS and `POST /t` takes an apiKey, which is exactly why a
client cannot create a topic and the `lobby` party is the replacement.

### Distribution and project operations

- **catalog** — APK/artifact hosting with version tags, retention, Slack notification, iOS
  ad-hoc OTA, and a self-updating Flutter installer app gated on `admin_locked` teams.
- **site** — one live tree per site at `g.yyt.life/{slug}/`, no history; redeploy to roll
  back. Every site also has its own origin at `{slug}.g.yyt.life`, and may replace
  its random slug with a globally unique name.
- **project tracker** — free-string versions linked to artifacts and asset versions,
  per-project numbered issues (close/reopen, comments), team discussions, and an
  append-only team history written in the same transaction as the change it records.
- **events** — a date vote plus a markdown page: `draft → voting → waiting → opened →
closed`, status derived lazily on read (no scheduler), every edit a revision, one event
  per calendar day, early close by an admin with a stored, publicly shown reason.
- **show** — a gallery of entries pointing at first-class resources, `public` or
  `member-only`, never widened once it has entries; likes and comments.
- **audit log** — every operator override is logged with a required reason and is readable
  by admins through the API, the SPA and `yyt audit`.

### Organization and permission

`Team → Project → Resource`. **Permission is team membership, nothing finer**: a member
reads and writes every project, resource and secret of the team; an owner adds member
management; a platform admin may list and delete but **never reads or writes a secret**
(non-secret config reads do succeed). Two surfaces sit outside that rule on purpose:
platform-global **events** and **shows**, where a show carries its own small per-member
write grant table. There is no global team listing for members, and leaving revokes
nothing — the response lists which credentials to rotate instead, because automatic
revocation would kill a running game.

### Client libraries

The wire packages — `gamebase-client`, `kvstore-client`, `auth-client`, a
`platform-client` for the surfaces without one, and an `asset-client` for encrypted and
resumable asset downloads (server live, the library **designed**, `docs/asset-encryption.md`) — map to the server. Above them, **designed
but not yet shipped in any language**, sits one **game kit** per language (TypeScript, C#,
Dart) whose modules are shaped by _purpose_ rather than by routes: `session`, `content`,
`save`, `room`, `turns`, `board`, `mail`, `friends`, `matchmaking`. Identical module,
method, event and error names in all three, a shared scenario list as the conformance
test, and one public kit config block per project printed by the console. No engine
plugin (Unity, Unreal, Godot) exists or is planned.

## 5. Design invariants

The rules that generalize, each earned from a specific failure:

1. **Generalize the shape, never the game.** Four storage shapes, two purpose-built
   stores, and a scope-routing relay whose only game-aware check is a movement delta.
2. **Every write that can race is conditional.** `If-Match` on documents,
   `If-None-Match: *` for one-shot claims, write-once asset keys, claim-before-copy on
   every upload.
3. **Everything expires.** Every Redis key carries a TTL in the same command as its write;
   one daily sweep runs eleven budgeted phases over channels, catalog, assets, kv,
   leaderboards, social, events, shows, sites and Redis ACLs. Channels live 7 days,
   extendable by 7 up to 28; expired → disabled → deleted after 30 days, unless a platform
   admin granted the channel no expiry.
4. **Credentials are derived, scoped and printed whole.** Redis prefixes and ACL usernames
   are computed from the channel id, never typed; a credential is shown as one copyable
   block because a retyped prefix fails `NOPERM` or — worse — silently relays nothing.
5. **Refuse loudly, within a surface.** A message whose capability is off is a typed
   error, never silence. The honest limit: composition **across** surfaces is unchecked —
   a lobby `partySizeMax` below the match `partySize`, or a member without a lobby socket,
   fails quietly, which is why the client recipes carry their preconditions in prose.
6. **The console owns the schema.** `auth`/`topic`/`match` hold one `SELECT`-only account
   each; `state` alone adds write rights on its own tables. MySQL grants are per table, so
   those accounts do see every channel's `secret_json` — the grant is the only control,
   and rows carrying secrets are never cached.
7. **One process, one region, no replication yet.** The gateway's global peer index is
   trivial because there is exactly one of it. The price is stated rather than discovered:
   there is no zero-downtime story anywhere — a stack deploy ships everything merged, a
   gateway restart disconnects every player, and the deploy order is manual and part of
   the contract (the **consumer of a new field ships first**).

## 6. Deliberate absences

| Capability    | Absent                                                 | Status   | Why                                                                                    |
| ------------- | ------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------- |
| Identity      | guest/device sign-in, account linking, refresh         | gap      | every player needs a GitHub or Google account through the team's own OAuth app         |
| Storage       | queries, secondary indexes, joins                      | gap      | every store is primary-key addressed; console list search is an un-indexed scan        |
| Storage       | change feeds / client listeners                        | gap      | nothing on a store notifies anyone; the relay is not attached to storage               |
| Storage       | managed datastores (DynamoDB, RDS)                     | refused  | self-hosted MariaDB + Redis is the settled decision at this traffic                    |
| Durability    | replication, a documented RPO in this repo             | gap      | one box; backup/restore lives in the private ops repo                                  |
| Realtime      | horizontal scale, multi-region                         | deferred | one process; replication is not built **yet**, and the ceiling is not reached          |
| Realtime      | message history / replay in `topic`                    | refused  | rooms are ≤ 20 min and stateless; a party or a document is the durable thing           |
| Authority     | server-authoritative simulation, forgery-proof results | deferred | authority is the game's Lambda or the host client; quorum attestation is designed only |
| Authorization | per-user or per-resource ACLs on project resources     | refused  | permission is team membership; the catalog's per-app grid was removed on purpose       |
| Multi-tenancy | per-tenant quotas or isolation                         | deferred | shared Redis with `allkeys-lru`; the answer today is observation and revocation        |
| Web hosting   | per-site origins (`{slug}.g.yyt.life`)                 | live     | every site gets one; the path URL keeps the shared origin and its documented rule      |
| SDK           | engine plugins; a shipped purpose-shaped kit           | deferred | wire packages exist; the kit is designed, waves A–C unstarted in the client repos      |
| Contest ops   | judging, scoring, prizes, submission deadlines         | gap      | a gallery records what was built; ranking it is not modelled                           |
| Platform      | push notifications, email, payments                    | refused  | out of scope for a contest platform                                                    |

## 7. Ceilings

Where the platform binds first, and what binds it:

| Ceiling                        | Value                                                                                                                                     | Bound by                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Concurrent players (gateway)   | design ~10; socket cap 64; 256 MB container                                                                                               | one process on a shared box                                    |
| MariaDB connections            | 55 reserved of 60                                                                                                                         | `reservedConcurrency` summed across five stacks                |
| Redis                          | 256 MB, `allkeys-lru`, shared by both stages and every participant                                                                        | no per-account quota exists                                    |
| API throttles                  | state 20 rps / 40 burst (shared by `/s`, `/kv`, `/lb`, `/social`); console 50 / 100                                                       | one stage's whole surface                                      |
| CloudWatch alarms              | 10 (8 prod + 2 dev)                                                                                                                       | account free tier; adding one means dropping one               |
| Public CDN traffic             | per distribution: 10 GiB or 2 M requests in 5 min, 100 GiB or 20 M requests a day                                                         | the CDN guard disables it (console: alert only)                |
| Frames                         | 16 KB inbound, 32 KB outbound; topic 16 KB                                                                                                | refused, not truncated                                         |
| Document / kv value            | 64 KB per document, 10 000 documents per channel                                                                                          | refused, not trimmed                                           |
| Leaderboard                    | 2 000 entries per bucket (hard 10 000), retain ≤ 12 periods                                                                               | worst case `maxEntries × (1 + 2 × (retain + 1))` rows          |
| Per-project and per-team scope | 5 teams/member, 20 projects/team, ~50 resources of each kind per project                                                                  | list scans stay bounded without an index                       |
| Asset storage                  | 2 MiB per file, 20 MiB per bundle, 400 MiB per project; an admin may grant up to 256 MiB per file, 3 GiB per bundle and 5 GiB per project | the CDN guard's lines; totals from a covering index, not scans |
| Recorded writes                | 2/s per member                                                                                                                            | every team, event and show write takes the slot                |

Monitoring is one liveness probe reporting only the down and recovered edges after two
consecutive failures, plus one daily usage digest (Redis memory, evictions, per-channel
key counts, bucket growth, CDN bytes per distribution) published as a single message, plus a
CDN cost guard every 5 minutes that disables a public distribution past its trip threshold
(watched by the prod liveness probe; manual stops: `scripts/cdn-switch.sh`,
`scripts/cdn-quarantine.sh`), with the S3 origins closed to anonymous reads
(CloudFront reads them through origin access control, `scripts/origin-oac.sh`). Account-level Budgets and Cost Anomaly Detection cover the bill
itself. No custom metrics.

## 8. Evolution levers

Framed decisions waiting for a reason to be taken. The backlog itself is machine-local; the
reasoning for each is in `docs/decisions.md`.

- **Ship the game kit** (waves A–C) in the three client repositories, and recreate the
  gateway container so `/presence` answers — the two things standing between the current
  server surface and a complete client story.
- **Quorum-attested writes** — N party members submit one identical value within T seconds;
  the only way a client-only game commits a result nobody can forge alone.
- **A second Redis instance for participants**, with its own `maxmemory` — the only real
  isolation between a participant's game and the platform's own state.
- **Read-only ACL selectors for `q` credentials** so a game reads a party roster without
  the gateway HTTP hop.
- **Gateway scale-out** — requires replacing the single global peer index; not until the
  ceiling is actually reached.

## 9. Source of truth

| Topic                          | File                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| Settled decisions (contract)   | `docs/decisions.md`                                              |
| JWT contract shared with games | `docs/auth-game-contract.md`                                     |
| Realtime gateway               | `docs/realtime-gateway-design.md`; wire spec `gateway/README.md` |
| Key-value store                | `docs/kvstore.md`                                                |
| Leaderboards                   | `docs/leaderboard.md`                                            |
| Social graph and presence      | `docs/social.md`                                                 |
| Team → Project → Resource      | `docs/team-project.md`                                           |
| Client-only games              | `docs/serverless-client.md`                                      |
| Client library design          | `docs/game-kit-design.md`                                        |
| Contest day, end to end        | `docs/playbook-contest-day.md`                                   |
| Secrets policy                 | `docs/secrets.md`                                                |
| Engineering rules              | `rules/index.md`                                                 |
