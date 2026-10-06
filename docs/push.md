# Push notifications (`push`)

Design of record: `docs/decisions.md` _Push notifications (Android, FCM)_ (2026-10-06). This page is the client contract and the operator's reference. Route-level detail of the state half is in `services/state/README.md` (_Push routes_).

**Status.** Built 2026-10-06, not deployed on any stage: the `push` channel kind and its console routes, the device-token routes and the targeted send on the state stack, migration `m0028_push`, the daily sweep. The console SPA and `yyt push …` are built too (_Console SPA and CLI_ below); the routes are what they call. Decided and **not built**: the deferred-match hook, campaigns and the broadcast topic, the console app's notifications (_Not built yet_ below).

## What a push channel is

A project resource like a match channel: `{id, apiKey, config: {authChannelId, packageName, sender}}`.

- `authChannelId` — the auth channel of the same project whose players receive. A device token is registered with that channel's JWT and belongs to its `sub`.
- `packageName` — the Android application id (`com.example.game`: two or more dot-separated segments, at most 255 characters). Unique per stage among `platform`-sender channels, compared without case. Fixed at creation.
- `sender` — `platform` (default) or `team`. Fixed at creation.
  - `platform`: the platform registers the package in one of its own Firebase projects and hands back the `google-services.json`. The team never opens the Firebase console.
  - `team`: the team brings its own Firebase project and service-account key. The platform registers nothing and only sends.
- `apiKey` — the credential of the send route. Shown once at creation and at rotation.

Transport is FCM and nothing else. A channel stays in the Firebase project it was registered in for life, because its device tokens are bound to that project.

## Registration flow

1. A team member creates the channel: `POST /projects/{prj}/channels` with `{kind: "push", name, config: {authChannelId, packageName}}`. The answer (201, `no-store`) is the channel view plus `apiKey`.
2. The member downloads `GET /channels/{id}/google-services.json` and puts the file in the Android app module. The file carries no send permission.
3. The app obtains its FCM registration token and sends it to the state stack on **every start** and on every token refresh (_Device tokens_).
4. The team's server sends with the `apiKey` (_Targeted send_).

A registration is created in this order: the channel row, then the claim (package name, the team's limit, a pool slot), then the Firebase app. Any failure removes the claim and the row — and the Firebase app, when the failure came after Firebase answered — so a refused create leaves no channel behind.

## Console routes

Session cookie or `yyt_` token; team membership as for every project resource. Errors are `{error: {code, message, details?}}`.

| Route                                     | Who            | Does                                                                                                                                                                             |
| ----------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /projects/{prj}/channels`           | member         | creates and registers; 201 with the view and `apiKey`                                                                                                                            |
| `GET /channels?kind=push`                 | member, admin  | lists; also `GET /projects/{prj}/channels?kind=push`                                                                                                                             |
| `PATCH /channels/{id}`                    | member         | `{name?, config?: {authChannelId}}`; `packageName` and `sender` are accepted only when unchanged; 409 `not_registered` with `config` while a platform registration is unfinished |
| `POST /channels/{id}/rotate-secret`       | member         | new `apiKey`; the old one stops at once; a registered team key is kept                                                                                                           |
| `DELETE /channels/{id}`                   | member         | 204; removes the Firebase app at once, frees the package name and the team's count, drops the tokens and the send counters                                                       |
| `GET /channels/{id}/google-services.json` | project reader | the raw file, `content-disposition: attachment`, `no-store`; takes the caller's write slot (429)                                                                                 |
| `PUT /channels/{id}/sender-key`           | member         | `{serviceAccount}` registers or replaces the team's key; 200 with the view                                                                                                       |
| `DELETE /channels/{id}/sender-key`        | member         | `{removed: boolean}`; 409 on a `team`-sender channel                                                                                                                             |
| `GET /limits?scope=team:<id>`             | member, admin  | the `push.appsPerTeam` row beside `team.projects`                                                                                                                                |

**View.** The base channel fields plus `config: {authChannelId, packageName, sender}`, `registered` (the platform registration exists, so the config file can be downloaded), `teamProject` (the team's own Firebase project id, once a team key is registered) and `apiBase` (the state stack's base URL; absent on a stage without that stack). Never returned: the pool slot, the Firebase app id, a platform project id, the team key.

**Create errors.**

| Status | `details`                            | Meaning                                                                                                                         |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 400    | —                                    | invalid config (package name grammar, unknown field, `teamServiceAccount` with `platform`)                                      |
| 400    | `{reason: "service_account", field}` | the team key was refused; `field` names what, never the value                                                                   |
| 400    | `{reason: "package_refused"}`        | Firebase refused the package name                                                                                               |
| 409    | `{reason: "package_taken"}`          | another `platform` channel of the stage holds the name, or the pool project holds it under an app the platform did not register |
| 409    | `{limit: "push.appsPerTeam", value}` | the team's limit; ask for one more with a limit request                                                                         |
| 429    | —                                    | the per-member write slot                                                                                                       |
| 503    | `{reason: "push_not_configured"}`    | the stage has no Firebase project yet                                                                                           |
| 503    | `{reason: "push_pool_full"}`         | every open slot is full; only a new Firebase project helps (an operator action)                                                 |
| 503    | `{reason: "firebase_unavailable"}`   | Firebase did not answer inside 15 s or refused the platform's key; create again later                                           |

A create that failed with `firebase_unavailable` may have registered the app in Firebase; the next create of the same package adopts it, and the daily reconciliation removes it otherwise.

**Config download errors.** 409 `{reason: "not_registered"}` (a `team`-sender channel, or a registration that never finished), 409 `{reason: "registration_missing"}` (Firebase no longer lists the app), 429 (the per-member write slot: every download is a Firebase Management call on a quota the pool project shares), 503 `firebase_unavailable`, 503 `push_not_configured`.

**Patch errors.** 409 `{reason: "not_registered"}` when `config` is sent for a `platform` channel whose registration has not finished (the create is still running, or was cut off and waits for the reconciliation); a `name`-only patch is not affected.

**Limits.** `push.appsPerTeam` is a team-scope key: soft 2, hard 5, step 1. It counts the team's `platform`-sender channels over the whole pool; a `team`-sender channel counts against nothing. Request and approval work as for `team.projects` (`docs/decisions.md` _Limit requests_). One Firebase project takes 20 registrations, a constant no request raises.

## Console SPA and CLI

Both call the routes above and nothing else; neither sends a message (the send route takes the channel `apiKey`, which only the team's server holds).

- **SPA** (`apps/console-web`):
  - _New channel_ (`/ui/teams/{team}/projects/{prj}/channels/new`, kind `push`): auth channel, package name (the server's grammar, checked before any request), sender. `team` adds a masked service-account key field. A refusal is shown where it can be acted on: `package_taken`, `package_refused` and `service_account` (one sentence per `field`) under their field; `push.appsPerTeam` as a notice linking to the team's Limits; `push_not_configured`, `push_pool_full`, `firebase_unavailable` and the write slot's 429 as a notice that says nothing in the form is wrong. The `apiKey` is shown once on the page that follows.
  - Channel page (`/ui/channels/{id}`): package, auth channel, sender, the `registered` badge, _Download google-services.json_ (disabled with the reason while there is no platform registration; 429 and the Firebase refusals have their own sentence), the API base and the three state routes, rotate / extend / delete (the delete confirm names the Firebase registration and the device tokens). _Edit_ changes the name and the auth channel only; a 409 `not_registered` says the registration is not finished.
  - _Team sender key_ card on the channel page: register, rotate, remove. The key is typed into a masked field and never shown again; only `teamProject` comes back. _Remove_ is off on a `team`-sender channel.
  - Team page → _Limits_: the `push.appsPerTeam` row with its usage and _Request increase_.
  - `/ui/admin/push-pool` (platform admin): one row per slot — label, apps / 20, state (`open`, `closed`, `full`, `not provisioned`), who closed it and when. _Close slot_ / _Open slot_ behind a confirm; a slot the platform closed itself (`platform (app limit)`) also offers _Keep closed_, which takes the closure over.
- **CLI** (`cli/internal/cmd/push.go`, `cli/README.md` _Push notifications_):
  - `yyt push channel create --name n --auth <auth> --package com.example.game [--sender team --service-account <file|->]`, `yyt push channel ls|get|update|rotate|delete|extend <channel>` — the `yyt channels` commands with the kind fixed (`yyt channels … --kind push` is the same thing). `update` takes `--name` and `--auth`; the package and the sender are fixed.
  - `yyt push channel config <channel> [-o <file>|-] [--force]` — the `google-services.json`; an existing file is kept unless `--force`.
  - `yyt push channel sender-key set <channel> --service-account <file|->`, `yyt push channel sender-key rm <channel>` — the key is read from a file or stdin and never printed.
  - `yyt push pool [ls]`, `yyt push pool close <slot>`, `yyt push pool open <slot>` — platform admin. `close` on a slot the platform closed itself takes the closure over and prints `closed`.
  - A refusal carries its next step: the `yyt limit request push.appsPerTeam +1 --team …` line, one hint per `details.reason` (a `service_account` refusal also names the `field`), the write slot for a 429. There is no `yyt push send`.

## Device tokens

State stack, base URL = the view's `apiBase`. `Authorization: Bearer <player JWT>` of the push channel's **auth channel**; a JWT of another channel and a doc apiKey are 403. The user is the JWT's `sub` and nothing in the body.

| Route                            | Body                | Answer                                             |
| -------------------------------- | ------------------- | -------------------------------------------------- |
| `PUT /push/{channelId}/token`    | `{token, project?}` | 204                                                |
| `DELETE /push/{channelId}/token` | `{token}`           | 204, idempotent; removes the caller's own row only |

- `token` is the FCM registration token: printable ASCII without blanks, at most 4096 characters. Unknown body fields are a 400.
- `project` is `project_info.project_id` of the `google-services.json` the app was built with. Optional while the channel accepts one project; **required** once it accepts two — a platform registration plus a team key (400 `push_project_required`). A project the channel does not accept is 400 `push_project_refused`; the accepted ids are never named. Always sending it is the simple rule.
- **One row per token per channel.** Inside a channel, a token registered again under another user moves to that user, so a shared device follows whoever registered last. Channels are independent: registering a token in one channel never moves or removes the row another channel holds for the same token.
- **At most 5 tokens per user per channel.** A sixth evicts the least recently refreshed; the one just written always stays.
- **A token not refreshed for 60 days is deleted** by the daily sweep. `PUT` on every app start and in `onNewToken` keeps it alive; a refresh of an existing token costs one upsert.
- Call `DELETE` on sign-out. A token FCM reports as unregistered is deleted by the send that met it — that channel's row only.

## Targeted send

`POST /push/{channelId}/send`, `Authorization: Bearer <push channel apiKey>`. A doc apiKey and a player JWT are not credentials here. Server-side only: the key must not ship in an app.

```json
{
  "userIds": ["<userId>", "…"],
  "data": { "kind": "invite", "partyId": "p1" },
  "notification": { "title": "Party invite", "body": "alice invited you" },
  "priority": "high",
  "ttlSec": 600,
  "collapseKey": "invite"
}
```

| Field          | Rule                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `userIds`      | 1–500 user ids of the auth channel; duplicates are folded                                                                                  |
| `data`         | object of string values, at most 64 keys; no empty key and none FCM reserves (`from`, `notification`, `message_type`, `google.*`, `gcm.*`) |
| `notification` | `{title, body}`, both strings, `title` not empty                                                                                           |
| `priority`     | `high` or `normal`                                                                                                                         |
| `ttlSec`       | integer 0–2,419,200 (28 days, FCM's maximum)                                                                                               |
| `collapseKey`  | 1–64 printable ASCII characters                                                                                                            |

At least one of `data` and `notification` is required. Together they hold at most **4096 bytes**, measured as the UTF-8 JSON of `{data, notification}` — quotes and braces included, so stricter than FCM and never looser (400 `push_payload_too_large`). Unknown fields are a 400.

**Answer** (200, `no-store`), one line per user id, never per device:

```json
{
  "results": [
    { "userId": "…", "status": "sent" },
    { "userId": "…", "status": "no-token" },
    { "userId": "…", "status": "failed", "reason": "unavailable" }
  ],
  "sent": 1,
  "noToken": 1,
  "failed": 1
}
```

| `status`   | `reason`       | Meaning                                                                                                | Retry                                |
| ---------- | -------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `sent`     |                | FCM accepted the message for at least one of the user's devices                                        | —                                    |
| `no-token` |                | the user holds no token in this channel                                                                | no; fall back to in-app reads        |
| `failed`   | `budget`       | the call ran out of time before this user's devices                                                    | send those ids again now             |
| `failed`   | `unavailable`  | FCM gave no verdict (quota, 5xx, network)                                                              | later, with backoff                  |
| `failed`   | `rejected`     | FCM will not take the message for these devices, or the channel holds no working key for their project | no; the same call fails again        |
| `failed`   | `unregistered` | every device of the user was gone; the tokens are deleted                                              | no; the next send answers `no-token` |

- A user with several failed devices is reported with the first of `budget`, `unavailable`, `rejected`, `unregistered` that applies.
- `sent` is acceptance by FCM, not delivery (_What push does not do_).
- The route is **not idempotent**: a repeated call sends again. Resend only the ids that failed with `budget` or `unavailable`, and set `collapseKey` when a duplicate would hurt.
- One call sends for at most 20 s, then spends up to 2 s on its counters and on deleting dead tokens (after the last message, never between two; what does not fit is left to the next send or the daily sweep, and the answer is not held back). Give the HTTP client a timeout of 30 s. 500 users with 5 devices each are 2,500 messages, 500 at a time, 20 in parallel.
- The route runs on a function of its own with **two containers** per stage: a third concurrent send is throttled by Lambda (a 503/429 from API Gateway, without this API's error body), so serialize sends per channel on the caller's side and retry a throttled call with a backoff — it never ran, so nothing was sent. The stage's state API throttle (20 rps, burst 40) is shared with every other state route.
- A whole-call 503 `push sender unavailable` means FCM refused the platform's key, or the pool lost the channel's project. Messages sent before the refusal are out; the call is the operator's to fix.

## Team sender (graduation)

A team that outgrows the shared projects moves to its own Firebase project without losing the installed base.

1. `PUT /channels/{id}/sender-key` with the team project's service-account key (the downloaded JSON, as a string or an object; at most 16,384 characters). The key must be allowed to send FCM messages; the platform asks for the messaging scope only. `token_uri` must be absent or Google's own endpoint.
2. The channel now accepts tokens of **both** projects, and `project` is required on `PUT …/token`.
3. The team ships an app build with its own `google-services.json`. Each token is sent with the key of the project that issued it, so both generations of the app keep receiving while the old tokens age out.

- The key is stored like an auth channel's provider secrets and is never returned, logged or audited; the view shows `teamProject` only. Replacing it is another `PUT`.
- `DELETE …/sender-key` removes it from a `platform` channel. The team project's tokens stay until they go stale and answer `failed` / `rejected` meanwhile; registering the key again revives them.
- A channel created with `sender: "team"` (the key in `config.teamServiceAccount` at creation) has no platform registration, no config download, and counts against no limit. It holds no package name either: its `packageName` is informational, any number of `team` channels may carry the same one, and it never blocks a `platform` channel from registering that name.
- When FCM refuses the team's key, that project's users answer `failed` / `rejected` and the platform project's tokens are still sent.
- Tokens cannot move between Firebase projects.

## State route status codes

| Status | Body                                                                                                 | When                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 204    |                                                                                                      | token registered, refreshed or removed                                                   |
| 200    | results                                                                                              | a send, whatever the per-user outcome                                                    |
| 400    | `details.reason`: `push_project_required`, `push_project_refused`, `push_payload_too_large`, or none | invalid body                                                                             |
| 401    | `api key required`                                                                                   | send without the channel's apiKey; a token route without a valid JWT                     |
| 403    |                                                                                                      | a JWT of another auth channel, or a credential that is not a player's                    |
| 404    |                                                                                                      | no such push channel (a deleted one included)                                            |
| 409    | `details.reason: "push_not_registered"`                                                              | the channel has neither a platform registration nor a team key                           |
| 410    |                                                                                                      | the channel is expired or disabled; extend it in the console                             |
| 503    | `details.reason: "push_not_configured"`                                                              | the stage has no Firebase project                                                        |
| 503    | `push sender unavailable`                                                                            | FCM refused the platform key, or the channel's slot left the pool                        |
| 503    | `push pool unavailable`                                                                              | the pool could not be read on a cold container                                           |
| 503    | `database error`                                                                                     | the state account lacks its grant on `push_tokens` (_Operator_), or the database is down |

## What push does not do

- **iOS.** APNs needs each team's Apple key; out of scope.
- **Devices without Google Play services** get nothing. The app reads over HTTP while it is open.
- **Delivery guarantee.** `sent` means FCM accepted the message. Doze, a force-stopped app, a full FCM queue or an expired `ttlSec` can still drop it. No receipt, no open tracking.
- **Topics, broadcast, campaigns, scheduling.** Not built (_Not built yet_).
- **Per-device targeting, token listing or export.** Tokens are platform-internal; no team-facing route returns one.
- **Deduplication.** Two calls are two messages.

## Operator

### The pool

- The stage's pool is every `SecureString` directly under SSM `/yyt-service/{stage}/push/fcm/`. The last name segment is the **slot label** (`p1`, `p2`, …; `^[a-z][a-z0-9-]{0,31}$`), and the value is that Firebase project's service-account key JSON. No project id appears in source, docs, logs or audit rows: a slot is named by its label everywhere, and each project id goes into gitignored `local/identifiers.extra.txt` (then `scripts/local-identifiers.sh`), so the commit hooks refuse it.
- Both stacks read the path at run time (`GetParametersByPath`, with decryption) and cache the list 10 minutes per container. A new slot needs no deploy. A failed reload serves the previous list and retries after a minute.
- Placement packs: the first slot in natural label order (`p2` before `p10`) that is open and holds fewer than 20 registrations.
- A parameter with a bad label, a malformed key, or a project another slot already names is skipped, logged by label (`push pool slot skipped`) and named in the daily digest (`push:pool:skipped:{label}`).
- A container whose first read of the path fails answers 503 `push pool unavailable` from memory for a minute before it reads again.
- A path with no parameter is a stage without push: channel create answers 503 `push_not_configured`, and nothing else is affected.

### Adding a project

1. Create the Firebase project. Enable the Firebase Management API and the Firebase Cloud Messaging API on it.
2. Create a service account that may send FCM messages and create, list, read the config of and remove Android apps, and download a key.
3. Optional: `POST /admin/push/pool/{slot}/close` first, so the new slot takes no registration until it is opened. A slot may be closed before its parameter exists.
4. `aws ssm put-parameter --type SecureString --name /yyt-service/{stage}/push/fcm/{slot} --value file://<key.json>`, then delete the local key file.
5. Add the project id to `local/identifiers.extra.txt` and run `scripts/local-identifiers.sh`. `local/identifiers.txt` itself is generated and would lose a hand edit.
6. `GET /admin/push/pool` lists the slot as `provisioned: true` within 10 minutes.

Never remove a parameter while channels live in its slot: their token and send routes answer 503 `push sender unavailable`, a delete of such a channel keeps its claim (nothing can remove the Firebase app), the pool view shows the slot as `provisioned: false`, and the digest warns `push:slot:unprovisioned:{slot}`.

The Firebase Management calls were written from the public reference; `packages/push/src/management.ts` lists the assumptions the first run against a real project must confirm.

### IAM and grants

- Console and state roles each hold `ssm:GetParametersByPath` on the path and `kms:Decrypt` conditioned on `kms:ViaService` = SSM and on the parameter ARN under that path. Console passes the path to `api` and `expire` only.
- After `m0028_push` is applied, the state MySQL account needs (private ops repo):
  - `SELECT, INSERT, UPDATE, DELETE` on `push_tokens`. Until then every `/push/*` route answers 503 `database error` and the rest of the stack works.
  - `SELECT, INSERT, UPDATE` on `push_send_stats`. The counter write is `INSERT … ON DUPLICATE KEY UPDATE col = col + VALUES(col)`, which on MariaDB needs `INSERT`, `UPDATE` **and `SELECT`** (the assignment reads the column; `ERROR 1143` without it, measured on 10.5). Without this grant sends still work; each logs `push send stats failed` and the digest shows no send failures.
- `push_apps` and `push_pool` are console's alone. The match account gains `SELECT` on `push_tokens` with the deferred-match hook.
- Device tokens are readable by more accounts than those grants name: auth, topic and match hold a database-level `SELECT` today (`rules/security.md`); narrowing them is an owner item.

### Closing and opening a slot

- `GET /admin/push/pool` → `{configured, slots: [{slot, provisioned, closed, closedBy, closedByLogin, closedAt, apps, capacity: 20}]}`.
- `POST /admin/push/pool/{slot}/close` and `…/open` → `{slot, closed, changed}`. Platform admin, write slot, audited as `push.pool.close` / `push.pool.open`. Closing a slot the platform closed itself takes the closure over (`changed: true`, `closedBy` becomes the admin).
- A closed slot takes no new registration; its channels keep registering tokens and sending. Close the previous slot before a contest to give it a fresh project.
- **Auto-close.** The platform closes a slot itself, with `closedBy: "auto:firebase-limit"`, when Firebase refuses a registration at its own 30-app limit (the create then tries the next slot once) or when the daily reconciliation counts 28 or more apps in the project — the net for apps added by hand, since the platform's own removals end in a purge. The reconciliation reopens such a slot once the count is below 28. A slot an operator closed, or took over by closing it again, is never reopened automatically.

### Deleting

- A channel delete removes the Firebase app with `immediate: true` — its place in the project and its package name are free at once, and it cannot be restored — then the claim, then up to 10,000 tokens and the channel's send counters.
- When Firebase does not confirm the removal inside 8 s, or the pool no longer returns the claim's slot, **the claim stays**: the package name and the team's count remain held until the daily sweep's retry succeeds. Without the claim nothing would name the Firebase app.
- An expired channel releases its registration when the sweep soft-deletes it, 30 days after it was disabled.
- A platform-registered app pending deletion (removed by hand without `immediate`, or soft-removed by a reconciliation that did not finish) still holds its name; the next create of that package purges it and registers anew.

### Daily sweep and digest

Console `expire` runs the push sweep before the usage digest, in five phases; one that throws is logged (`push sweep phase failed`), named in the digest and does not stop the others:

1. the registrations of channels the expiry just soft-deleted;
2. tokens (and send counters) of dead channels;
3. tokens older than 60 days (20 batches of 1,000 per run);
4. send counters older than 30 days;
5. each slot's claims against Firebase's app list.

Phases 1 and 5 share one 90 s deadline, checked before every release and every Firebase call, and 20 Firebase removals per run; a claim whose release failed in phase 1 is not retried until tomorrow. Log lines: `push sweep` or `push sweep truncated`.

| Finding      | Meaning                                                                                                                             | Digest warning            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `orphans`    | active Firebase apps no claim names that are still there: added by hand or by another stage (**never touched**), or not yet removed | `push:orphans:{slot}:{n}` |
| `removed`    | apps carrying this stage's marker that no claim named, purged on this run (left by a failed create)                                 | `push:removed:{slot}`     |
| `missing`    | live channels whose Firebase app is gone, pending deletion or was never created                                                     | `push:missing:{slot}:{n}` |
| `foreign`    | claims whose package Firebase lists under an app this stage did not register; never adopted                                         | `push:foreign:{slot}:{n}` |
| `filled`     | claims that lacked an app id and took the platform-registered app of their package                                                  | —                         |
| `repaired`   | channels whose stored slot and app id were rewritten from the claim                                                                 | —                         |
| `released`   | claims of dead channels given back on this run                                                                                      | —                         |
| `unread`     | Firebase's app list was not read (no answer, or out of time); the slot is unreconciled today                                        | `push:unread:{slot}`      |
| `autoClosed` | the slot was closed at 28 listed apps                                                                                               | `push:autoclose:{slot}`   |
| truncated    | a budget ran out; the rest waits for tomorrow                                                                                       | `push:sweep:truncated`    |

An unclaimed platform app is removed only after the claim was read again by package name **after** Firebase's list was fetched: a create writes its claim before it calls Firebase, so an app that is listed while no claim of the slot names its package is one a rolled-back or timed-out create left. The removal itself is two steps, because a retry of that create can adopt the app at any moment: a soft removal (the app is pending deletion and restorable), the claim read once more, then the purge with `immediate: true`. An app a claim names by then is restored instead and not counted as `removed`; a failed restore is logged as `push reconciliation: claimed app not restored` and counted in `missing`. A purge that did not fit leaves the app pending deletion for the next run.

Further digest warnings:

- `push:pool:low` — 5 or fewer registrations left over the open slots; adding a project is the only way to grow.
- `push:tokens:{channelId}` — a channel holding more than 100,000 tokens.
- `push:send:failed:{channelId}:{day}` — one of the five channels with the most users not reached on the previous UTC day, with that day's counts (`push_send_stats`: calls, users reached, users without a token, users failed, dead tokens dropped). Counts only.
- `push:pool:unreadable` — the SSM path could not be read; nothing was reconciled.
- `push:pool:skipped:{label}` — a parameter under the path that is not served (bad label, malformed key, duplicate project).
- `push:slot:unprovisioned:{slot}` — registrations name a slot the pool does not return.
- `push:sweep:failed:{phase}` — a sweep phase threw.

The digest line itself carries the five channels with the most tokens, each slot's registration count and the previous day's send failures. Warnings are announced once per level, so an orphan count that does not change is mailed once.

- **An app registered by hand is one orphan for good.** The console app is to be added to the first slot's project by hand; from then on that slot reports `orphans: 1`, announced once. It occupies one of Firebase's 30 and none of the platform's 20.
- **The marker.** Every app the platform registers is named `yyt-push:{stage}:{channelId}`, and a stage adopts and removes only apps carrying its own `yyt-push:{stage}:` prefix; another stage's apps in the same project are counted as orphans and never touched. A hand-registered app must not use a display name starting with `yyt-push:`: it would be treated as the platform's, and removed by the reconciliation when no claim names it.
- **Callers of `send` should retry on 503** (and 429), with a backoff: the function is capped at 2 concurrent invocations per stage, so a third send at the same moment is throttled and not queued. The exception is a 503 `push sender unavailable`, which is the operator's to fix and may have sent some messages already.
- **Send counters.** Every send adds its counts to one row per channel and UTC day, best effort: a failed write is logged (`push send stats failed`) and the send still answers. Rows are kept 30 days. Each send also writes one `push send` line to the `pushSend` function's log group with counts only (`sent`, `noToken`, `failed`, per-outcome `outcomes`, `deleted`, `ms`).
- Other lines worth a filter: `push sender refused` and `push slot missing` (state, error, by slot label), `push registration failed`, `push app removal failed` and `push rollback left a firebase app` (console), `push pool load failed`.

### Rollout order per stage

1. Owner: Firebase project, APIs, key into SSM (_Adding a project_).
2. `scripts/deploy.sh console <stage>` — applies `m0028_push`.
3. `scripts/deploy.sh auth <stage>`, `topic`, `match` — **before the first push channel exists**: their older bundles throw on a `push` row (a 5xx where a 404 belongs) when a caller names a push channel's id.
4. Owner: the state account's grants on `push_tokens` and `push_send_stats`.
5. `scripts/deploy.sh state <stage>` — adds the `pushSend` function (2 reserved containers; state is 8 of the MariaDB budget, 57 of 60 in all).
6. `scripts/deploy-web.sh <stage>`.
7. `node scripts/smoke/push.mjs <docBase> <debugKey> <authBase> <consoleBase>` (dev).

Rolling console back past `m0028_push`: hard-delete the `push` channel rows and their `push_apps` rows first (`rules/deployment.md`).

## Not built yet

Decided in `docs/decisions.md`, tracked in the machine-local backlog:

- **Deferred-match hook** (_Match: deferred mode_ #5): a match channel naming a `pushChannelId` and sending `{channelId, matchId, state}`.
- **Campaigns and broadcast** (#7b, #7c, #9): templates, CSV jobs, reports, the per-channel FCM topic, and the limits `push.recipientsPerJob` and `push.jobsPerDay`.
- **Console app notifications** (#10): the app joining the first pool project and one topic per installed catalog app.
- **Client libraries**: no `push` package exists in tslib, csharplib or flutterlib; an app calls the two token routes directly.
