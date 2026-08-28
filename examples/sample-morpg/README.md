# sample-morpg — a MORPG loop on the yyt realtime gateway

The second sample game, built on top of `examples/sample-dungeon`: a persistent
**lobby** on the platform's `lobby` channel (movement, chat, party, an opaque
`dungeon.offer` event), an instanced **dungeon** on a `q` channel driven by a
tslib actor at 5 Hz, and **character sheets** in the doc store. It is the
implementation of the blueprint that follows it in this file (§1–§8, kept as
the design record) and the reference consumer of the gateway's
`GET /parties/{partyId}` route.

```
client ──JWT──▶ gateway lobby (pos / say / party / event)
   │  leader: POST /dungeon/enter {partyId}      ──▶ game http Lambda
   │                                                  ├─ GET gateway /parties/{partyId} (same JWT)  ← roster, never the client's
   │                                                  ├─ save GameActorStartEvent + invoke actor
   │                                                  └─ wait readyCall (PUT /dungeon/ready/{gameId}/{secret}) → {wsUrl, gameId}
   └──────── same JWT ──▶ gateway q channel ◀──Redis list / pub-sub──▶ actor: map → sim → frames → result delta
                                                                          └─ commit per member: doc GET → apply once by gameId → PUT If-Match
```

## Layout

| File                          | Role                                                                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/handler.ts`              | Lambda entry points `http` (entry API, readyCall sink, character read + sheet routes) and `actor`; the only module reading env.                                                                                         |
| `src/env.ts`                  | Env contract; derives the pub/sub prefix and the gateway HTTP base from the `q` channel URL.                                                                                                                            |
| `src/entry.ts`                | `POST /dungeon/enter`, `PUT /dungeon/ready/{gameId}/{secret}`, `GET /character` and the sheet routes (stats-up, inventory, equipment, npc, zone) — pure of AWS, every side effect injected.                             |
| `src/actor.ts`                | `handleActor` + `runGameAllTogether` with a fixed 200 ms tick, one world frame per tick, commit-then-result at the end.                                                                                                 |
| `src/sim.ts`                  | Pure dungeon simulation: mmo101 rules (retaliatory aggro, leash 5, 30 %/s melee, projectile skill, drops, quests, death/respawn).                                                                                       |
| `src/map.ts`                  | The map bundle format (§4.6, format 2) — parser, collision, spawn marks, data-driven clear conditions (`kill` / `device` / `item`); hands `templates` to `templates.ts`.                                                |
| `src/templates.ts`            | The world bundle's game templates (items, abnormalities, quests, town NPCs, zones): types, the shared id grammar, a validating parser that resolves relative zone bundle URLs.                                          |
| `src/character.ts`            | The character sheet (format 2: stats, inventory + equip slots, quest states, timed abnormalities), leveling, `applyResult` (idempotent by `gameId`), pure transitions (equip/use/quest/stat points), `effectiveStats`.  |
| `src/doc.ts`, `src/commit.ts` | Doc store client (`ETag` / `If-Match`) and `updateSheet`: read → pure transform → conditional write, retried on 409; `commitResult` (apply-once by `gameId`) is one transform. Every lobby transition goes through it.  |
| `assets/zone001.json`         | The world bundle (20×10 town + slime field, `clear: kill boss`) with every template: 7 items, the `rage` buff, 4 quests, 4 town NPCs (two quest givers, two gates), 2 zones.                                            |
| `assets/zone002.json`         | The forest field zone002 teleports to (wolves + an alpha, `clear: kill alpha_wolf`); no templates of its own — a field-only bundle.                                                                                     |
| `scripts/local-api.mjs`       | Runs the `http` handler on localhost (esbuild bundle) against dev — pair it with a local gateway to iterate without redeploying.                                                                                        |
| `cli/`                        | The terminal client (`pnpm play`): `session.ts` drives the lobby and `q` SDK clients, `state.ts`/`render.ts` are the pure model and screen, `commands.ts` the keys and slash commands, `terminal.ts` the only TTY code. |
| `scripts/play.mjs`            | Bundles `cli/main.ts` with esbuild (`.esbuild/cli/`) and runs it; the client imports `src/map.ts`, `src/sim.ts`, `src/character.ts` types directly.                                                                     |
| `serverless.yml`              | httpApi (8 routes) + the actor (timeout 900 s, no retries). No WebSocket API: the sockets live in the gateway.                                                                                                          |

## Protocol

Lobby: exactly the gateway's `lobby` protocol (`gateway/README.md`); the game adds three `event` names, all `scope: "party"` and relayed unread by the gateway: `dungeon.offer` / `dungeon.accept` (the party agreeing to go) and `dungeon.start {gameId}` (the leader telling the members which run to join — only the caller of `POST /dungeon/enter` learns the `gameId`; a member honours it only from the current leader, and the `q` channel still admits only the start event's members).

HTTP (`Authorization: Bearer <channel JWT>`):

| Route                                      | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /dungeon/enter {partyId}`            | plays the field of the leader's zone (`templates.zones[zone].mapUrl`, else the world bundle) — the start event carries that `mapUrl`; leader only (`403 not_leader`); roster from the gateway (`404 party_not_found` for unknown _and_ non-member); one dungeon per party (`409 party_in_dungeon {gameId}` while the actor's lock lives, `409 entering` while another call is in flight); `200 {gameId, wsUrl, members}` once the actor's readyCall landed, `504 actor_not_ready` after 8 s (the party is freed; a retry allocates a new `gameId`) |
| `PUT /dungeon/ready/{gameId}/{secret}`     | the actor's readyCall; `200` with the secret the entry issued, `404` otherwise                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /character`                           | `{userId, version, sheet}` — the caller's own sheet (a fresh one at version 0)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST /character/stats-up {stat, points?}` | spends stat points (`maxHp`/`attack`/`defence`, 1 point per unit, as mmo101); `400 no_points`, `400 bad_stat`/`bad_points`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /inventory/{itemId}/use`             | uses one item in town: a `buff` starts or extends its abnormality, weapons/armor equip; `409 no_item`/`not_usable`/`field_only` (potions)/`too_many_buffs`, `404 unknown_item`, `502 unknown_template` (a bundle hole)                                                                                                                                                                                                                                                                                                                             |
| `POST /inventory/{itemId}/equip`           | puts an owned weapon/armor in its slot; `409 no_item`/`not_equippable`, `404 unknown_item`; re-equipping the slot's item writes nothing                                                                                                                                                                                                                                                                                                                                                                                                            |
| `DELETE /equipment/{slot}`                 | `weapon`/`armor`; `409 not_equipped`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST /npc/{id}/interact {questId?}`       | talks to a town NPC (mmo101 quest interaction): a ready quest is turned in first (`action: completed`), otherwise the next acceptable one is accepted (`action: accepted`); `questId` narrows the choice; a gate NPC (`teleport`) answers `action: teleported` with the zone route's extras (`questId` is then `404 unknown_quest`); `404 unknown_npc`, `409 quest_incomplete` (`go`), `409 nothing_to_do` (`nothing`), `409 not_repeatable`, `404 unknown_quest`                                                                                  |
| `POST /zone/{id}`                          | the game decides zone changes: records the zone in the sheet and answers `{zone, start, mapUrl?}` (`mapUrl` when the zone has its own bundle) — the client draws that grid and re-announces `pos` there; `404 unknown_zone`                                                                                                                                                                                                                                                                                                                        |

Every sheet route answers the `GET /character` row (`{userId, version, sheet, effective}` plus the route's extras; `effective` = base + equipped bonuses + live buffs, from the server's templates) after one CAS write (`updateSheet`); a refusal writes nothing. A slot, verb or id outside the grammar (`[a-z0-9_-]{1,32}`) is a route-level `404 not_found` before any read. Item/quest/NPC/zone templates are the world bundle's `templates` (`MAP_URL`, fetched once per container and injected as `EntryOptions.templates`); a bundle without them refuses every named thing and leaves `stats-up` / `DELETE /equipment` working.

Dungeon (`q` channel, `wsUrl` + `&gameId=`):

| Direction | Message                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| client →  | `move {x,y}` (one adjacent walkable cell, 100 ms cooldown), `attack {uid}` (adjacent, 400 ms), `skill {dir}` (projectile, 3 s), `use {itemId}` (the `clear: item` key next to its cell, or a `potion` template: heals `heal` up to `maxHp` — a potion always heals, even if a bundle names it as the clear key; refusals `no_item`/`full_hp`/`nothing_happens`/`wrong_place`, plus `dead`/`cleared` like every command; gear and buffs are lobby matters), `operate` |
| server →  | `hello {gameId, mapId, mapVersion, mapUrl?, you}` (`mapUrl` = the field's bundle when the entry chose one) then a `frame` on enter/reconnect; `enter {memberId}`; `stage`; `refused {command, code}`                                                                                                                                                                                                                                                                 |
| server →  | `frame {time, cleared, players[], monsters[], projectiles[], events[]}` every tick (self-contained; `events` are the hits/kills/drops/heals/deaths since the last one)                                                                                                                                                                                                                                                                                               |
| server →  | `result {reason, cleared, rewards:{memberId: {exp, items, consumed, questProgress}}, committed:{memberId: applied\|duplicate\|skipped\|failed\|pending}}` then close `1000` — `skipped` = never entered or nothing earned; `failed`/`pending` = the delta is parked in Redis (`{prefix}pendingcommit:{gameId}:{memberId}`, 24 h) for an operator to replay, since `applyResult` is idempotent by `gameId`                                                            |

### The character sheet (format 2)

One JSON document per player in the doc store, the game's own schema (`src/character.ts`): `level/exp/statPoints`, base `maxHp/attack/defence`, `items` (itemId → count; loot lands here directly), `equipment` (`weapon`/`armor` → itemId, the item stays in `items`), `quests` (questId → `{active, progress, completed}`; kill progress from a run counts only while accepted, turn-in resets it and bumps `completed`, `repeatable` gates re-accepting), `abnormalities` (`{templateId, endsAt}` epoch ms; using the same buff again adds its duration; expired ones are ignored by `effectiveStats` and dropped on the next buff use), `appliedGames`. Item/abnormality/quest templates come from the world bundle (`Templates`, §4.6); `effectiveStats(sheet, templates, now)` = base + equipped bonuses + live buffs. Format 1 documents are upgraded on read (numeric quest counts become accepted quests). Potions are refused in the lobby (`field_only`): HP exists only inside a run, where `use` heals and the result's `consumed` takes the potion out of the bag. A run starts every member at `effectiveStats(sheet, world.templates, now)` and freezes them: a buff expiring mid-run keeps working until the result is committed (the dungeon never re-reads the sheet, §4.3).

## Play (terminal client)

`cli/` is a two-terminal MORPG client on `@yingyeothon/gamebase-client`: an ASCII map from the bundle, chat, party, dungeon frames at 5 Hz, and the character sheet from `GET /character`. It is the proof that the platform is enough — no Unity, no C# SDK.

1. Config: `pnpm install` (the client and esbuild are dev dependencies), then a gitignored env file (`local/deploy/morpg-cli.<stage>.env` in the service repo, or anywhere):

   ```
   MORPG_API_BASE=https://<the stack's ApiUrl>
   MORPG_GATEWAY_WS_URL=wss://gw-dev.yyt.life
   MORPG_STATE_FILE=/path/to/state.json      # {"authChannelId":"ch_…","lobbyChannelId":"ch_…","qChannelId":"ch_…"} — the smoke's state file works as is
   MORPG_TOKEN=<a channel JWT, used verbatim>   # or, dev only, mint one per --user from a debug key:
   MORPG_AUTH_BASE=https://auth-dev.yyt.life
   MORPG_DEBUG_KEY_FILE=/path/to/debug-key
   ```

   `--user <name>` becomes a stable 32-hex id (a hash of the name); flags override env vars override the file (`cli/config.ts` `USAGE`).

2. Two terminals, two names: `pnpm play -- --config ../../local/deploy/morpg-cli.dev.env --user alice` and `--user bob`. The same name twice ends the older socket with close `4000` (the gateway's single-session rule); the client says so and exits.
3. Town: `wasd`/arrows/`hjkl` move (applied locally, `pos` at most every 200 ms and at once after 3 cells, the gateway's `maxMoveDelta`), plain text or `/say` for zone chat, `/p` party chat, `/w <user> <text>` whisper, `/party create|invite <user>|accept|decline|leave|list`. Town NPCs are drawn from the world bundle's templates at their cell (the side panel lists `npcs: hunter(H) @3,1 …`); `/talk <npcId>` accepts or turns in that NPC's quests, `/talk forest_gate` walks through the gate into zone002 (its own grid, its own field; the sheet remembers the zone across sessions), `/talk town_gate` comes back. Talking checks the sheet, not the player's cell: the gateway owns positions and the game never sees them (§4.3), so adjacency to an NPC is not enforced.
4. Dungeon: the leader runs `/offer`, members `/accept`, the leader `/enter` (`POST /dungeon/enter`, then `dungeon.start` to the party); everyone joins the `q` channel. `wasd` sends one `move` per adjacent cell, `f`/space attacks the weakest adjacent monster, `q` fires the skill in the facing direction, `/use <itemId>`, `/operate`. Back in town the sheet routes are `/stats <maxHp|attack|defence> [n]`, `/use <itemId>` (buffs, gear), `/equip <itemId>`, `/unequip weapon|armor`, `/talk <npcId> [questId]` and `/zone <zoneId>`; each answer replaces the side panel's sheet. The `result` frame shows the rewards; any key (or 8 s) returns to town, reloads the sheet and re-announces `pos`.
5. Runs last `GAME_RUNNING_SECONDS` (the smoke's env writes 120 s; raise it before deploying for a human party). The SDK reconnects both sockets with backoff; the side panel shows `reconnecting #n` and the actor replays `hello` + `frame` on re-entry.

The client is ANSI/raw-mode only (no Windows console support), needs at least 60×16 and refuses to start without a TTY. Peer text is stripped of control characters before it reaches the screen. Everything except `terminal.ts`/`main.ts` is pure or injected and covered by `test/cli-*.test.ts`.

## Deploy and verify

1. `scripts/smoke/morpg.mjs setup <debugKey> https://auth-dev.yyt.life https://console-dev.yyt.life https://doc-dev.yyt.life <outEnv> <outState>` (from the service repo) seeds an auth channel, a lobby + a `q` channel with its participant Redis credential, the doc apiKey and the asset bundle (every `assets/*.json` under `v1`), points the lobby's `mapUrl` at the world bundle, and writes the deploy env. After editing a bundle: `scripts/smoke/morpg.mjs publish-map <debugKey> <consoleBase> <outState> <outEnv> <version>` uploads a new immutable version, repoints the lobby and rewrites `MAP_URL` — then redeploy (step 2).
2. `pnpm install && pnpm typecheck && pnpm test`, then `scripts/deploy.sh <outEnv> dev` — the output's `ApiUrl` is the stack's HTTP base.
3. `scripts/smoke/morpg.mjs run <debugKey> <authBase> <consoleBase> wss://gw-dev.yyt.life <outState> <ApiUrl> [<outEnv>]` plays the whole loop with two synthetic players: the sheet routes on a fresh sheet (refusals, quest accept/turn-in, gates, zones), the dungeon (bots walk to the boss), a mid-run reconnect, the routes again with the boss killer's level-up and drops, and the lobby's single-session rule. With `<outEnv>` (its `DOC_API_KEY`) player b is seeded with potions and drinks one when the boss hits it — the heal event, the consumed delta and the bag are checked; without it those checks print `skip`. `scripts/smoke/morpg.mjs timeout …` (same arguments; the env file only bounds the wait) idles a solo run until the running stage times out (`result {reason: "timeout"}` + close 1000; takes the `GAME_RUNNING_SECONDS` the stack was deployed with). An interrupted `run`/`timeout` leaves its actor alive until then; the actor's `reservedConcurrency` (10) is the number of such runs that can overlap before `enter` answers `504 actor_not_ready`. Then `clean`.

The dev gateway must run an image that has the `/parties` route. To iterate locally: run the gateway on `127.0.0.1:8089` (`rules/manual-verification.md`), then `set -a; . <outEnv>; set +a; GATEWAY_WS_URL="ws://127.0.0.1:8089/?channel=<qId>" CALLBACK_BASE_URL=<ApiUrl> GAME_ACTOR_LAMBDA_NAME=yyt-sample-morpg-dev-actor node scripts/local-api.mjs 8090` and point `run` at `ws://127.0.0.1:8089` / `http://127.0.0.1:8090`. The actor still runs in Lambda; only the sockets and the entry API are local.

Sizing: `GAME_RUNNING_SECONDS` (default 600) + 20 s wait + 20 s margin must stay under the actor's 900 s timeout; `MAX_RUNNING_SECONDS` in `src/actor.ts` enforces it at cold start. The commit phase at the end is bounded by `DEFAULT_COMMIT_DEADLINE_MILLIS` (10 s, members in parallel) so a slow doc store cannot eat the margin: whatever has not landed is `pending` and parked, and the party still gets its `result` and its close. A setup failure (map or sheets unreachable) also ends in a `result {reason:"error"}` rather than a hanging socket. The map bundle is cached per Lambda container (immutable per URL).

Every function in `serverless.yml` carries a `reservedConcurrency`; it is a free ceiling that silently throttles past its number, so raise it with your party size and player count rather than removing it.

## Blueprint status (§7 checklist, verified on dev 2026-08-29)

1–6 lobby relay / leave / retained position / scope routing / party / offer-decline: **pass** (`scripts/smoke/gateway.mjs` + `morpg.mjs`). 7–8 party authorized, outsider rejected: **pass**. 9–10 reward persisted, replay not duplicated: **pass** (`test/commit.test.ts` for the replay; the smoke checks `appliedGames` holds the `gameId` once). 11 actor death → `4001`: gateway-side, covered by its own tests. 12 reconnect resync from one frame: **pass** (`morpg.mjs run` closes b's `q` socket once the stage is `running`, reconnects, and expects `hello` + one two-player `frame` while the leader sees the `enter` again). 13 gateway restart mid-dungeon: observed once, not scripted — a gateway restart closes every socket with `1001` and the actor keeps ticking (it logs `no gateway is listening` until a gateway subscribes again); the smoke's clients run with retries off, so they stop there, and the reconnect half (the SDK's default backoff) is expected rather than verified. Scripting it needs a gateway restart. 14 single-session rule: **pass** (a second lobby socket of the same user closes the first with `4000`). 15 full-length run: **pass at `GAME_RUNNING_SECONDS` = 240 s** (`morpg.mjs timeout`: an idle solo run ends with `result {reason: "timeout"}` and close `1000`, not a cut-off socket); the 600 s default was not run end to end — its sizing (running + wait + margin under the 900 s Lambda timeout) is enforced at cold start by `MAX_RUNNING_SECONDS`.

---

# mmo101 on yyt — game-side blueprint (design record)

## Why this document exists

`examples/sample-dungeon` proves the platform wiring works. This one was the
opposite direction: it described a **real game** before it existed, so that
implementing mmo101 against `service` and `tslib` would **discover what the
platform still gets wrong**. The implementation above is the result; the first
thing it found was that the entry API had no way to read a roster (fixed by the
gateway's `/parties` route).

Treat it as a verification harness written in prose. Every section ends with
what it would reveal about the platform if it turns out to be hard.

Companion documents: `docs/realtime-gateway-design.md` (the platform side of the
same plan) and `tslib/todo-fix.md` (the library side). This file never repeats
them; it references them.

> **Note on those references.** `todo/` is gitignored (`.gitignore:22`) and
> `tslib` is a separate repository, so both are working notes local to the
> author's machine, not part of this public repo. Where a reference matters to
> someone reading only this file, the platform behaviour it points at is
> restated here rather than left as a pointer. Item ids like "G2" or "P0 #0" are
> stable handles into `tslib/todo-fix.md` for whoever has it.

---

## 1. Baseline: what mmo101 is today

Source: `~/git/lache/mmo101` (C#, .NET 6, ~4,700 lines).

- A **single stateful process** holding the whole world in memory, speaking
  JSON over WebSocket, persisting only `UserEntity` to its own DynamoDB.
- **Two zones** (`Zone001`, `Zone002`, linked by a teleport NPC), each a 100x100
  character grid loaded from a text file. Combat, monsters, quests and skills all
  happen on those shared maps.
- **No dungeons, no instances, no parties.** Grep the repo for
  dungeon/instance/party/raid and you find nothing.
- No world tick. Every object runs its own `async void … while(true) { …;
await Task.Delay(n) }` loop: users 500 ms, monsters 1 s, the spawner 1 s,
  projectiles 500 ms.
- Broadcast is a direct method call on peer `User` objects, zone-wide, with no
  interest management.

**So this is not a port.** The dungeon, the party and the lobby/dungeon split
are new game design. Only the _rules_ — stats, damage, drops, quests, leveling —
carry over.

---

## 2. Target structure

|                                                                      | Where it runs                     | Who builds it                      |
| -------------------------------------------------------------------- | --------------------------------- | ---------------------------------- |
| **(a)** Lobby: movement, chat, party view/form/leave                 | wsgw `lobby` channel              | platform                           |
| **(b)** Dungeon entry negotiation (offer, y/n, enter or leave party) | wsgw `lobby` channel, party scope | platform (relay) + game (decision) |
| **(c)** Dungeon: spawn, movement, combat, quests, reward, clear      | game actor Lambda + game store    | game                               |

(a) and (b) are generalised into the **lobby protocol** — a positional message
plus a predefined event set — so that the next game gets them for free. (c) is
the game's, built on `lambda-gamebase` + `gamebase-all-together` plus the game's
own storage for map, NPC, inventory and party persistence.

**Forward-looking:** map, NPC, inventory and party are the obvious next
candidates to graduate out of the game and into `services/` once a second game
needs them. Build them in the game first, deliberately, and generalise from two
real users rather than one imagined one.

### The loop

```
lobby (persistent, hours)                     dungeon (instanced, <=12 min)
  move / chat / form party
  someone offers a dungeon
  everyone answers y/n  ──────────────────▶  entry API allocates gameId,
  (decline = leave party)                     invokes actor, waits readyCall
                                              party connects to the q channel
                                              spawn / fight / quest / clear
  ◀────────────────────────────────────────  reward committed, party returns
```

---

## 3. What the platform must provide (and what to check)

### 3.1 Lobby protocol

Specified in `docs/realtime-gateway-design.md` §2.3. The game depends on:

- `hello` as the first frame — `{ userId, tick, mapUrl, capabilities, zone }`.
  The client holds no content and no configuration of its own; it downloads the
  map from `mapUrl` the way a browser loads a page, renders it, does local
  collision, and enables UI according to `capabilities`. Everything else in
  this list assumes that posture.
- `pos { zone, x, y, dir }` relayed zone-wide, with **gateway-synthesised
  enter/leave**. Without the synthesis a character who walks away freezes on
  everyone's screen — the ghost bug mmo101 has today.
- `say { scope, text }` for zone / party / whisper chat.
- `party.*` operations with the roster mirrored to Redis, so the game's entry
  API can read a roster it did not have to trust a client for.
- `event { scope, name, payload }` — an opaque relay. Dungeon offer/accept rides
  on this, and so does anything else the game invents later.

This lobby channel enables **all** the capability flags — `pos`, `say` with all
three scopes, `party`, `event`, and `debug` while developing (the admin commands
in §6 have no authorization of their own). A chat-only or movement-only channel
is the same code with fewer flags; see §2.3 of the gateway plan.

User-to-user chat matters here specifically: mmo101 has only zone-wide
`broadcastText` today, so whispering between two players in different zones is a
new capability the lobby brings, not something being ported.

**What it reveals:** if the client needs a build to change the map, `hello`
metadata is being bypassed — the map must be data, not content baked into the
client, or the future web editor has nothing to publish to. If the game finds
itself asking the gateway to understand a payload, the scope model is too
narrow. If it finds itself polling for party
state, the roster mirror is missing or stale. If a disabled capability fails
silently instead of returning a typed error, the flag validation was skipped.

### 3.2 Dungeon channel

Specified in `docs/realtime-gateway-design.md` §2.4-2.5. The game depends on:

- Connection authorization against `GameActorStartEvent.members`, so a client
  cannot join another party's dungeon by guessing a `gameId`.
- The gateway subscribing to the outbound channel **before** the first inbound
  push, so no frame is lost at start-up.
- Actor-death detection with a distinguishable close code, so the client shows
  "the dungeon stopped responding" rather than a fabricated result screen.

**What it reveals:** a dungeon that dies and leaves clients hanging means §2.5
was not implemented. A dungeon that another player can join means G5 was skipped.

---

## 4. What the game must build

### 4.1 Entry API (HTTP, game's stack)

`POST /dungeon/enter { partyId }`:

1. Read the party roster from `party:{channelId}:{partyId}` — never from the
   request body.
2. Allocate a fresh `gameId`. **Never reuse one**: a crashed actor's lock
   survives for `lifetimeSeconds + 10` (up to ~730 s) and the id is unusable
   until then.
3. Invoke the actor Lambda asynchronously with
   `GameActorStartEvent { gameId, members, callbackUrl }`. **`callbackUrl` is
   mandatory** — `readyCall` only fires when it is set, and without it clients
   get a `wsUrl` before anything is listening.
4. Wait for `readyCall`, then answer `{ wsUrl, gameId }`. Treat readyCall as
   idempotent: a duplicate invocation signals ready a second time even though it
   cannot acquire the lock.
5. On timeout, fail the party cleanly and allocate a new `gameId` on retry.

### 4.1b Use the client SDK, do not hand-roll the protocol

Both clients — the Unity one and `GameTerminal` — should sit on the TypeScript
client SDK (`tslib/todo-fix.md` G7) rather than each reimplementing the wire
format. The peer map built from synthesised `enter` / `leave` / `pos` frames is
the single most-copied piece of logic and the one where a missed `leave` leaves
a ghost on screen; it belongs in the SDK.

The Unity client is the awkward case: it shares the server's compiled assembly
today (`GameClient/Assets/Plugins/MMO101Logic.dll`, `Client.cs:8`) and cannot
consume a TypeScript package. Either port the SDK to C# once the protocol is
frozen, or keep the C# client on a hand-written implementation of the same
frozen table — but decide, because two independent implementations of a protocol
that is still moving is how the ghost bugs come back.

### 4.2 The dungeon actor

`runGameAllTogether` with:

- `lifetimeSeconds` ~720 (12 minutes, party loading included). The hard ceiling
  is the 900 s Lambda limit; gamebase does not hand off, it simply ends.
- **A 5 Hz fixed tick**, not 10 Hz. `naive-socket` is a serialized request queue
  with no pipelining, and the actor talks to a self-hosted Redis over the
  internet: at 10 Hz the round trips do not fit in the budget. See
  `tslib/todo-fix.md` G1.
- **Self-contained snapshot frames**, one shared world frame per tick broadcast
  to the whole party, plus small private frames only when something private
  changes. Do not send per-player AoI snapshots — they would be unique per
  recipient and defeat the multi-target publish that makes the tick affordable.
- `onMemberEntered` sends a full snapshot, which is also the reconnect path.

Simulation to implement (this is the C# that carries over):

| mmo101 source                           | ~lines | Destination                                                                   |
| --------------------------------------- | ------ | ----------------------------------------------------------------------------- |
| `MonsterNpc.cs`                         | 216    | dungeon actor (TS)                                                            |
| `MonsterZone.cs`                        | 86     | dungeon actor (TS)                                                            |
| `Projectile.cs`                         | 85     | dungeon actor (TS)                                                            |
| `Stats.cs`, damage math in `User.cs`    | ~150   | dungeon actor (TS)                                                            |
| `GameData.cs` template loading          | 455    | shared TS loader (a partial one already exists at `GameTerminal/src/data.ts`) |
| `User.cs` inventory / quests / leveling | ~900   | **stays in the lobby**, see below                                             |
| `Zone.cs`, `ZoneManager.cs`, `World.cs` | ~330   | replaced by the lobby channel                                                 |
| `Session.cs`, `Message.cs` serde        | ~450   | replaced by the gateway + new protocol                                        |

Fold the four per-object `async void` timer loops into the single fixed tick,
and turn `GameObject.Run(action)` — currently a synchronous cross-thread call
that mutates the target and sends packets on the caller's thread — into queued
messages. The code's own TODO at `User.cs:456` anticipates this.

### 4.3 The authority boundary (hold this line)

> **The dungeon owns combat simulation only. It returns a result delta and never
> writes character state. The lobby is the single writer to the game's store.**

Result delta: `{ exp, items, consumed, questProgress }`, committed **idempotently by
`gameId`**. The actor queue is at-least-once on one path and at-most-once on the
other (`tslib/todo-fix.md` 5), and mmo101's EXP and drop grants are not
idempotent — a replay duplicates loot.

Holding this line is what keeps stats, items and quest rules in **one** language
instead of two. Cross it and the game maintains the same rules in C# and
TypeScript forever.

### 4.4 Clear conditions

Three, all of which should be data-driven rather than hard-coded, because they
are the part a contest team would want to author:

1. Defeat the final monster.
2. Operate a device at a location.
3. Use a given item at a designated location (the quest form).

Then: reward, `onGameEnd`, and back to the lobby.

### 4.6 Map bundle format

This is a **platform contract, not a game detail**: the client, the dungeon
lambda and the future map editor all parse it, and `docs/decisions.md` _Storage shapes_
defers the definition here. Settle it before either side is written.

**What mmo101 has today** (`GameLogic/GameData.cs:96-113,158-197`): three files
per zone, loaded from disk by a stateful process.

| file                | content                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `{zone}.origin.txt` | one tab-separated `x\ty` — the origin offset                              |
| `{zone}.map.txt`    | a character grid; `'x'` = non-movable, any other char = a spawn-area mark |
| `{zone}.link.txt`   | TSV, `mark<TAB>NpcTemplateId`                                             |

Two traps in that format, both of which must be fixed on the way out rather
than carried:

1. **The grid is stored bottom-up and reversed at load time**
   (`GameData.cs:184` — `File.ReadAllLines(mapFile).Reverse()`, commented "to
   avoid translate -y"). A file-format artifact that inverts the Y axis will be
   re-derived wrongly by every new consumer. Store rows **top-down** and say so
   in the spec.
2. **NPCs are only a mark-to-id link.** The actual templates live in separate
   data directories, so a map alone is not renderable or simulatable. The whole
   point of the asset is that one fetch is enough, so **NPC definitions are
   inlined** in the bundle.

**Target: one self-contained JSON document** (format 2), fetched by URL, parsed
by all three consumers (`src/map.ts` + `src/templates.ts`; `assets/*.json` are
the shipped ones):

```jsonc
{
  "format": 2, // bump on a breaking change
  "id": "zone001", // = the gateway zone string the client announces in `pos`
  "version": "2026-08-29-1",
  "size": { "w": 20, "h": 10 },
  "origin": { "x": 0, "y": 0 }, // grid cell of world (0,0)
  "blocked": "x", // the non-movable char
  "start": { "x": 1, "y": 1 },
  "rows": ["xxxx…", "x..a…"], // top-down, h strings of length w
  "npcs": [
    // monsters, inlined; the mark links to the grid (spawn area)
    {
      "mark": "a",
      "kind": "monster",
      "templateId": "slime",
      "stats": { "maxHp": 20, "attack": 4, "defence": 1 },
      "spawn": { "initial": 1, "max": 2, "ratePerSec": 0.1 },
      "exp": 10,
      "drops": [{ "itemId": "slime_jelly", "probability": 0.5 }],
    },
  ],
  "clear": { "kind": "kill", "templateId": "boss" },
  "templates": {
    // the game's data, once, for the client and the sheet routes (optional: a
    // bundle without it is a field-only grid)
    "items": { "wooden_sword": { "kind": "weapon", "bonus": { "attack": 5 } } },
    "abnormalities": { "rage": { "bonus": { "attack": 10 }, "seconds": 300 } },
    "quests": {
      "jelly_hunt": {
        "kind": "kill",
        "templateId": "slime",
        "count": 3,
        "repeatable": true,
      },
      "horn_trophy": {
        "kind": "collect",
        "itemId": "boss_horn",
        "count": 1,
        "repeatable": false,
      },
    },
    "npcs": {
      // town NPCs: drawn by the client at `at` in `zone` (default: this bundle's id)
      "hunter": {
        "at": { "x": 3, "y": 1 },
        "mark": "H",
        "quests": ["jelly_hunt"],
      },
      "forest_gate": {
        "at": { "x": 18, "y": 8 },
        "mark": "G",
        "quests": [],
        "teleport": "zone002",
      },
      "town_gate": {
        "zone": "zone002",
        "at": { "x": 1, "y": 2 },
        "mark": "G",
        "quests": [],
        "teleport": "zone001",
      },
    },
    "zones": {
      "zone001": { "start": { "x": 1, "y": 1 } }, // this bundle
      "zone002": { "start": { "x": 1, "y": 1 }, "mapUrl": "zone002.json" }, // its own bundle, relative to this URL
    },
  },
}
```

Rules the parser enforces (`parseMapBundle` / `parseTemplates`, each failure
names its field): ids are `[a-z0-9_-]{1,32}` and never a prototype slot; a buff
item names an abnormality, a collect quest an item, an NPC its quests and its
zone, a teleport its zone (and a gate has no quests); NPC marks are unique per
zone and, in this bundle's zone, distinct from the grid's own chars; NPC cells
and zone starts in this bundle's zone must be walkable; `zones` must include
the bundle's own id; a zone's `mapUrl` must be `http(s)` and a relative one
resolves against the bundle's URL (so `yyt asset push` of the whole directory
keeps them together). A kill quest's `templateId` is not checked against this
bundle's monsters — the wolf lives in zone002's field; the actor counts kills
against the _world's_ quests, whichever field it runs. Format 1 bundles still
parse (their `quests` array becomes repeatable kill quests, no other templates)
so a code deploy and a bundle publish need not land in the same instant — the
http Lambda otherwise answers `502` on every route while `MAP_URL` and the code
disagree. Leveling stays the `expForLevel` formula (no table); MP is dropped on
purpose (§6). A death respawns at 1 HP; `hp_potion` drops (and `use`
healing 30 in the field) are what make the alpha wolf survivable for a level-1
sheet.

**World bundle vs. field bundle.** The bundle behind the lobby channel's
`mapUrl` (= the stack's `MAP_URL`) is the _world_: its `templates` are what
`GET /character`, the sheet routes and the client read, and its grid is the
default zone's town. Every other zone in `templates.zones` has its own bundle:
the client fetches it on teleport (once per URL) and draws that zone's NPCs
from the world's templates; `POST /dungeon/enter` sends the party to the field
of the leader's zone (`mapUrl` in the start event, `hello.mapUrl` to the
clients), so a town and its field share one grid and one document.

Constraints that fall out of the platform, not the game:

- **Self-contained and immutable.** A new map is a new URL, delivered in the
  next `hello` (§3.1). Never mutate a published bundle — clients cache it
  forever by design (decided 2026-08-25).
- **The dungeon lambda parses the same document** and derives collision from the
  same `rows`. If the client and the server ever disagree about what is walkable,
  the server wins — but they must not disagree by construction, which is why
  there is one document and not two.
- **Size cap.** It is a public asset paid for per byte (observation is open in todo/15). A
  100x100 grid is ~10 KB of JSON; keep the tileset separate so a re-published
  map does not re-ship art.
- Everything under `npcs[].stats` / `spawn` is **game schema** — yyt stores and
  serves it without interpreting it, exactly like a `doc` body.
- **Publishing it** (shipped 2026-08-25): `yyt asset create <bundle>` once, then
  `yyt asset push <bundle> <version> <dir>` per release — the directory's layout
  becomes the bundle's, so `rows`'s `tileset: "art/tiles.png"` resolves relative
  to the map's own URL. Paste the resulting map URL into the lobby channel
  (`yyt channels update <id> --map-url …`); that pointer, not the CDN, is what
  makes a version live, so a rollback is a config edit and nothing is ever
  invalidated. Allowed extensions and caps: `cli/README.md` "Game assets".

---

### 4.5 Storage

The platform generalises **storage shapes, never game rules**. Every game datum
belongs to exactly one of three, and what a character or an item _is_ stays the
game's own schema, carried opaquely:

| shape         | backing                          | holds here                                 | who writes                               | can the client read it directly?          |
| ------------- | -------------------------------- | ------------------------------------------ | ---------------------------------------- | ----------------------------------------- |
| **asset**     | S3 + CDN                         | the map, with NPC definitions inlined      | `yyt asset push` (later: the map editor) | **yes** — a plain `fetch`, no credentials |
| **doc**       | MariaDB, versioned JSON with CAS | character sheet, inventory, quest progress | the game's lambda, with a channel apiKey | **read-only, own row only**               |
| **ephemeral** | Redis, TTL on every key          | party, dungeon runtime                     | the gateway / the dungeon actor          | no                                        |

Consequences worth stating plainly:

- **The map is not storage.** The client receives `mapUrl` in the gateway's
  `hello` frame (§3.1), GETs it like a web page, and does local collision. The
  dungeon lambda fetches the same URL server-side, because the dungeon is
  server-authoritative and needs identical collision data. Publishing a new map
  is a channel-config edit, not a cache invalidation.
- **The client never writes anything of value.** Splitting reads from writes is
  the same line as §4.3: a hacked client that could write its own inventory
  duplicates items, one that can only read it does not. Every write goes
  through the game's lambda.
- **A conditional write is mandatory, not advisory.** mmo101 today does an
  unconditional whole-blob `PutItem` (`ServerEntityManager.cs:82`) on a 60 s
  throttled, unawaited write-back, so two sessions duplicate an inventory. The
  doc shape exists partly to make that failure impossible: read a version,
  write with it, take a 409. Note that tslib's own `repository` package will
  _not_ save you here — `MapDocument.edit()` is read-modify-write and its
  `version` field is written but never compared, so it is safe only under an
  actor lock with exactly one writer. Inside the dungeon actor that holds; for
  a character sheet it does not.
- **Direction of travel.** The first plan had the game bring its own DynamoDB.
  That is still the fallback and still works — a participant may build every
  layer themselves. But the intent is that a participant ends up writing _only_
  a game lambda, in their own AWS account, with everything beneath it supplied
  by yyt. Prefer the platform shape where one exists.

---

## 5. Defects to fix while porting, not after

These are live in mmo101 today and survive any hosting choice:

- `Zone.AroundWithMe(x, y)` **ignores its coordinates** and returns every object
  in the zone (`Zone.cs:136-139`). Every broadcast goes through it, and it also
  means a client can interact with any object anywhere in the zone by uid.
- The 60 s write-back is not awaited (`UserManager.cs:341`) and
  `ForceDisconnect` does not save at all (`User.cs:105-116`).
- `Session` never checks `EndOfMessage` (`Session.cs:50-67`): a frame above
  64 KB is parsed per-fragment and kills the connection. Cap outbound frames
  well below 64 KB until the client is fixed.
- `MonsterZone._npcs` is a plain `List` mutated by the spawner while other
  threads iterate it; monster HP decrement is unsynchronised, so a double kill
  awards EXP and drops twice (`MonsterNpc.cs:175,187`). The actor's
  single-threadedness fixes this one for free.
- The duplicate-login retry loop has neither delay nor attempt cap
  (`UserManager.cs:74-77`).
- Both broadcast tests are `public async void [Fact]`
  (`UserBroadcastTests.cs:18,49`) — xUnit cannot await them, so their assertions
  may never run.

---

---

## 6. Full mmo101 feature inventory

Everything the current game does, so nothing is lost by accident when deciding
what the new structure absorbs. Grouped by where it plausibly lands.

### Stays in the lobby (persistent, per-character)

| Feature           | Detail                                                                                                                                                     | Source                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Account           | join / login, PBKDF2 password (**256 iterations** — raise it, or drop it for the platform JWT)                                                             | `PasswordSecure.cs:9-11`                   |
| Appearance        | free-form `look` string chosen at join, echoed on every spawn                                                                                              | `Message.cs:38-44`                         |
| Stats             | `Level, Exp, Point, MaxHp, Hp, MaxMp, Mp, Attack, Defence`                                                                                                 | `Message.cs:76-79`                         |
| Stat allocation   | `statsUp { statType, point }`, 5 points per level                                                                                                          | `User.cs:353-375`, `Constants.cs`          |
| Leveling          | cumulative EXP table, 100 lines, level cap 100                                                                                                             | `GameData/Level/Level001.txt`              |
| Inventory         | item list plus an `equipped` map keyed by `Weapon` / `Armor`                                                                                               | `Message.cs:161-175`                       |
| Item types        | `QuestGoods, Weapon, Armor, Potion, Abnormality`, each with a linked stats or abnormality template and a `consumable` flag                                 | `GameData.cs:233-260`                      |
| Equip / unequip   | `itemChanged { remove\|equip\|unequip }` plus an `effect` broadcast                                                                                        | `Message.cs:182-192`                       |
| Quests            | accept from a town NPC, collect N of an item, turn in; `repeatable` flag                                                                                   | `GameData/Quest/`, `User.cs:528-627`       |
| Quest UI          | `questboard` (all quests, doing and completed counts), `questProgress` (active), and `questNpc { state: nothing\|new\|finish\|go }` per-player NPC markers | `Message.cs:209-247`                       |
| Abnormalities     | timed buffs and debuffs carrying a stats delta and a duration; expiry is checked on the user tick and re-broadcast with `remainMillis`                     | `GameData/Abnormality/`, `User.cs:934-954` |
| Chat              | zone-wide `broadcastText`                                                                                                                                  | `User.cs:197-215`                          |
| Death and respawn | HP to 1, MP to 0, teleport to the start point, **no EXP loss**                                                                                             | `User.cs:1025-1039`                        |

### Moves to the dungeon (combat simulation)

| Feature          | Detail                                                                                                                                                         | Source                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Monster AI       | two states, `Roam` (10 % chance per second of a random step) and `Fight`. Aggro is **purely retaliatory** — there is no proximity scan                         | `MonsterNpc.cs:65-125`, `Constants.cs:21-25` |
| Chase and leash  | steps toward the target while within `MonsterResetDistance = 5`, otherwise drops aggro. No leash-to-spawn, no threat table                                     | `MonsterNpc.cs`                              |
| Melee            | `interaction` on an adjacent target; damage is `max(0, attack - defence)`; monsters hit with 30 % chance per second at distance ≤ 1                            | `MonsterNpc.cs:160`, `User.cs:490`           |
| Projectile skill | `/skill` fires a travelling object: 8 cells, 40 attack, 500 ms per step, hits the first object on its cell                                                     | `Projectile.cs`, `User.cs:1046-1076`         |
| Drops            | item bags are `(itemTemplateId, probability)` pairs rolled on kill. **Loot goes straight into the killer's inventory — there is no ground-drop object at all** | `GameData.cs:262-289`, `MonsterNpc.cs:208`   |
| EXP grant        | on kill, to the killer only                                                                                                                                    | `MonsterNpc.cs:188-214`                      |
| Spawning         | spawn areas derived from marked cells on the map: `initial = size/16`, `max = size/8`, 10 % dice per second                                                    | `MonsterZone.cs:32-49`                       |

### Needs a decision — no obvious home

| Feature                    | Detail                                                                                                                                                                                                                   | Why it is awkward                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Town NPCs**              | static, never move; interaction types `Drop` / `Quest` / `Teleport`                                                                                                                                                      | Lobby content, but today they are `GameObject`s inside the zone simulation. The new lobby gateway knows no NPCs, so they become the game's HTTP API plus client-side rendering from `GameData`. **Resolved (2026-08-29):** `templates.npcs` in the world bundle + `POST /npc/{id}/interact`; `Drop` is not carried (loot lands in the bag). |
| **`Bookmark` NPC type**    | a third `NpcType` beside `Monster` and `Town`                                                                                                                                                                            | Declared at `GameData.cs:296` and never used anywhere. Decide whether it was a planned feature or dead code.                                                                                                                                                                                                                                |
| **Teleport / zone jump**   | stepping on a teleport NPC's tile moves you to the linked NPC's position in another zone                                                                                                                                 | Server-side map logic a rule-free relay cannot do. See §2.3 of the gateway plan. **Resolved (2026-08-29):** a gate NPC with `teleport` → `POST /npc/{id}/interact` records the zone in the sheet and answers `{zone, start, mapUrl}`; the client re-announces `pos` (talking, not stepping).                                                |
| **`uiText`**               | rich text as `terms[{ text, id }]` — clickable spans referencing entity ids                                                                                                                                              | A genuinely good primitive with no equivalent in the new protocol. Carry it as a game-defined `event` payload.                                                                                                                                                                                                                              |
| **`effect`**               | `{ fromId, toId, attack\|equip\|unequip }`, purely visual, zone-broadcast                                                                                                                                                | Trivial, but it is the only "something just happened here" channel. Fold into the dungeon snapshot and the lobby `event`.                                                                                                                                                                                                                   |
| **Admin commands (18)**    | `/init /item /maxhp /maxmp /attack /defence /hp /mp /statpoint /resetstat /exp /teleport /startquest /finishquest /startab /endab /dead /skill`, parsed out of ordinary chat with **no authorization check of any kind** | Indispensable for demoing at a contest, and simultaneously a complete cheat menu shipped to every player. Keep them, behind an explicit debug flag on the channel.                                                                                                                                                                          |
| **`interaction` overload** | one message means use-item, complete-quest, attack-monster or talk-to-NPC, resolved by target type                                                                                                                       | Convenient for a terminal client, ambiguous as a protocol. Consider splitting by intent when redefining the wire format.                                                                                                                                                                                                                    |
| **Content pipeline**       | the Unity editor authors content, `ZoneExporter.cs` writes TSV, both client and server load the same files; ids are 32-char GUID hex                                                                                     | It works, but it binds content authoring to the Unity project. Decide whether the new game keeps it.                                                                                                                                                                                                                                        |

### Deliberately not carried over

- The four per-object `async void` timer loops become one fixed tick.
- Zone-wide broadcast with no interest management becomes scope routing.
- `Zone.AroundWithMe` ignoring its coordinates (§5).
- The `Session` framing bug, and the admin commands in their current
  unauthenticated form.
- `MaxMp`/`Mp`: the sample's skill is gated by a cooldown, not a cost, so the
  sheet and `statsUp` keep `maxHp`/`attack`/`defence` only.

## 7. Verification checklist

Run these against the built platform. Each one fails loudly if a specific piece
is missing.

1. Two clients in the same zone see each other move. _(lobby relay)_
2. One walks out of range or disconnects; the other sees them **removed**, not
   frozen. _(synthesised leave — the most likely omission)_
3. A stationary player is visible to someone who connects afterwards.
   _(retained position)_
4. Chat reaches zone, party and whisper scopes and no one else. _(scope routing)_
5. Form a party, see the roster, leave, see the roster update. _(party primitive)_
6. Offer a dungeon; every member gets the prompt; a decline leaves the party.
   _(event relay + game rule)_
7. Enter the dungeon; every member's socket is authorized. _(G5)_
8. A sixth client guessing the `gameId` is **rejected**. _(G5, the security case)_
9. Kill the boss, get the reward, return to the lobby with the reward persisted.
   _(result delta + commit)_
10. Replay the same result commit; the reward is **not** duplicated.
    _(idempotency)_
11. Kill the actor mid-run; clients are disconnected with the abort close code
    and the client shows an error, not a result. _(§2.5)_
12. Reconnect mid-dungeon; the client resynchronises from one snapshot frame.
    _(self-contained frames + `onMemberEntered`)_
13. Restart the gateway mid-dungeon; play continues after reconnect.
    _(snapshot self-healing)_
14. Open two lobby sockets as the same user; the second is refused or the first
    is dropped. _(single-session rule, §2.6)_
15. Run a dungeon for the full 12 minutes and confirm it ends cleanly rather
    than being cut off.

---

## 8. Platform gaps this will hit

Cross-references, so a failure has a known address:

- Wrong queue key or envelope: `tslib/todo-fix.md` G2 — the failure is
  **silent**, the actor simply never sees a message.
- 10 Hz tick overruns: G1 (multi-target publish) and the serialized-socket
  round-trip budget.
- Missing `EXPIRE` / `EVAL` in `naive-redis`: G6, which blocks G3 and P0 #2.
- Dungeon cannot restart after a crash: P0 #0 (`eventLoop` leaks the lock on
  throw) and P0 #3 (TTL longer than the actor's life).
- Lost `drop` or end-of-game frames after a gateway restart: 7b — snapshots heal,
  one-shot commands do not.
- An orphaned socket after a reconnect: 7c.
- Redis credentials crossing the internet in cleartext: 4b.
