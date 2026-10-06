# Push notifications (`push`)

Design of record: `docs/decisions.md` _Push notifications (Android, FCM)_ (2026-10-06). This page is the client contract and the operator's reference. Route-level detail of the state half is in `services/state/README.md` (_Push routes_).

**Status.** Built 2026-10-06, not deployed on any stage: the `push` channel kind and its console routes, the device-token routes and the targeted send on the state stack, migration `m0028_push`, the daily sweep. The console SPA and `yyt push …` are built too (_Console SPA and CLI_ below); the routes are what they call. Built 2026-10-06 on the server side, not deployed: campaigns and the broadcast (_Campaigns_ below) — migration `m0029_push_campaigns`, the console routes and the `pushJob` worker; the SPA and the CLI do not call them yet. Decided and **not built**: the console app's notifications (_Not built yet_ below).

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
| `GET /limits?scope=channel:<id>`          | member, admin  | `push.recipientsPerJob` and `push.jobsPerDay` beside `channel.lifetime` (_Campaigns_ → _Limits_)                                                                                 |
| `/channels/{id}/push/…`                   | member         | templates, uploads, jobs, reports, broadcast (_Campaigns_)                                                                                                                       |

**View.** The base channel fields plus `config: {authChannelId, packageName, sender}`, `registered` (the platform registration exists, so the config file can be downloaded), `topic` (the FCM topic of the channel's broadcast, `yyt.push.{id}`; _Broadcast_), `teamProject` (the team's own Firebase project id, once a team key is registered) and `apiBase` (the state stack's base URL; absent on a stage without that stack). Never returned: the pool slot, the Firebase app id, a platform project id, the team key.

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

## Campaigns

A campaign sends one templated message to the users a team lists in a CSV. Selection is the team's job: the platform has no query engine. Everything here runs on the **console** stack; the sends are made by its `pushJob` worker, not inside the request.

1. A member writes a **template** (title, body, data with `{{variables}}`).
2. The team uploads a **recipient CSV** (`userId` plus one column per variable) through a presigned PUT.
3. A **dry run** of `{templateId, uploadId}` reports what would happen and sends nothing.
4. The **job** sends, in batches of 500 rows, and ends `done` or `failed`.
5. The **report** names every row's result for 7 days.

A **broadcast** is the other shape: one message to the channel's FCM topic, no CSV (_Broadcast_).

### Two route families

| Family | Base                    | Credential                                                                  |
| ------ | ----------------------- | --------------------------------------------------------------------------- |
| member | `/channels/{id}/push`   | session cookie or `yyt_` token; a member of the channel's team              |
| apiKey | `/push-api/{channelId}` | `Authorization: Bearer <push channel apiKey>`, the key of the targeted send |

Both live on the console API host and serve the same eight job routes below with the same bodies and answers. Templates exist on the member family only.

- **apiKey family.** For a team's server. Only the bearer counts: a cookie or a `yyt_` token on these paths is a 401. The key is compared in constant time. A channel id that does not exist (or is not a push channel) answers the same 401 as a wrong key, so the family does not say which ids exist; a known channel with the right key that expired or was disabled answers 410. No CORS header is sent, so a browser cannot call it from another origin. Never ship the key in an app.
- **Write slot.** Every write but `POST {base}/uploads` takes one 500 ms slot — per member on the member family, **per channel** on the apiKey family, whichever server holds the key (429 `{retryAfterMs: 500}`). Reads take none. An upload takes none so the submit that follows it is not throttled; the 20 pending places bound it, and `DELETE {base}/uploads/{uploadId}`, which frees a place, takes the slot.
- A write by a member is audited under the member; one by the key is audited with `via: "apikey"`, and the job's `author` is the literal `apikey`.
- A platform admin without a seat in the team reads templates and jobs like every project read, and gets 403 on every write and on the report.
- Errors are `{error: {code, message, details?}}`; every answer is `no-store`.

### Templates

Member family only. At most **20 per channel** (a constant).

| Route                                               | Does                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `GET /channels/{id}/push/templates`                 | `{templates: [...], max: 20}`, by name                             |
| `POST /channels/{id}/push/templates`                | `{name, title?, body?, data?}` → 201 with the template             |
| `GET /channels/{id}/push/templates/{templateId}`    | the template                                                       |
| `PATCH /channels/{id}/push/templates/{templateId}`  | `{name?, title?, body?, data?}`; the message is checked as a whole |
| `DELETE /channels/{id}/push/templates/{templateId}` | 204; jobs already submitted keep their text                        |

A template: `{id, channelId, name, title, body, data, variables, createdBy, createdByLogin, updatedBy, updatedByLogin, createdAt, updatedAt}`. `variables` is the sorted list of names the message uses — the CSV columns a job needs.

- `name`: `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, unique per channel without case.
- `title`: at most 1024 characters, no control character. Empty means a **data-only** message.
- `body`: at most 4096 characters; `\n` and `\t` are the only control characters allowed. A body needs a title.
- `data`: an object of string values, at most 64 keys, no empty key and none FCM reserves (`from`, `notification`, `message_type`, `google.*`, `gcm.*`) — the targeted send's rule, from one shared validator (`@yyt/push`).
- A title or at least one data key is required.

**Placeholders.** `{{name}}`, where `name` is `[A-Za-z_][A-Za-z0-9_]{0,31}`, written without blanks. Allowed in `title`, `body` and the **values** of `data`; a data key is always literal. Nothing else is syntax: `{{ name }}`, `{{a.b}}`, `{{}}`, a lone `{{` and a 33-character name are sent as written. Placeholders do not nest, and a substituted value is never read again, so a value holding `{{x}}` stays that text. Names are case-sensitive.

**Size.** A message's `data` and `notification` together hold at most 4096 bytes, measured like the targeted send's. A template whose literal text alone is over the limit (each placeholder counted as one byte) is refused with 400 `push_payload_too_large`; what the variables add is checked per row when the job runs (_Recipient CSV_, `too-large`).

| Status | `details`                                | When                                                  |
| ------ | ---------------------------------------- | ----------------------------------------------------- |
| 400    | — / `{reason: "push_payload_too_large"}` | a rule above                                          |
| 404    | —                                        | no such template, or not a push channel of the caller |
| 409    | `{reason: "push_template_name_taken"}`   | another template of the channel has the name          |
| 409    | `{reason: "push_template_cap", max: 20}` | the channel holds 20                                  |
| 429    | `{retryAfterMs: 500}`                    | the member's write slot                               |

### Recipient CSV

- UTF-8. A leading byte-order mark is skipped. Invalid UTF-8 and a NUL byte are errors.
- Records end in LF or CRLF; a final line break is optional. An empty line is skipped and is no row. A CR without an LF is an error.
- RFC 4180 quoting, strictly: a field is quoted as a whole or not at all, `""` is a quote inside a quoted field, and a quoted field may hold commas and line breaks. A quote anywhere else is an error.
- The **first record is the header**. Every name is a variable name (the grammar above, case-sensitive), none twice, at most 32 columns.
- **`userId` is required** (spelled exactly so): a user id of the channel's auth channel, the `sub` of its player JWT.
- **A column that reads like a device token is refused** (`token`, `deviceToken`, `fcm_token`, `registrationToken`, `registration_id`, `pushToken`, … compared without case and underscores). Recipients are named by user id only; a device token never travels through a team's file.
- Every other column is a variable. A column the template does not use is ignored; a variable the template uses must be a column.
- Every row has exactly as many fields as the header.
- Limits: 1,024 bytes per record (quotes and commas counted, the line break not), 512 bytes per field, and the file at most **102,401,024 bytes** — the hard `push.recipientsPerJob` (100,000) plus a header, at 1,024 bytes each.

A file that breaks one of these rules is refused **as a whole and before anything is sent**: at submit when the header is wrong, by the worker's first pass otherwise (`csv_invalid`).

**Row rules** (a row that breaks one is reported and skipped; the rest are sent):

| Report `reason`    | When                                                                                |
| ------------------ | ----------------------------------------------------------------------------------- |
| `invalid-user`     | `userId` is not a player id                                                         |
| `duplicate`        | the `userId` appeared in an earlier row — the first row wins, whatever became of it |
| `missing-variable` | a variable the template uses is empty in this row                                   |
| `too-large`        | the rendered message exceeds 4096 bytes                                             |

### Job routes

Both families (`{base}` = `/channels/{id}/push` or `/push-api/{channelId}`).

| Route                              | Body                                                                                                | Answer                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `POST {base}/uploads`              | `{size}`                                                                                            | 201 upload                                                           |
| `DELETE {base}/uploads/{uploadId}` |                                                                                                     | 204; 409 `upload_in_use` while an unfinished job reads it            |
| `POST {base}/jobs`                 | `{templateId, uploadId, idempotencyKey, dryRun?, priority?, ttlSec?, collapseKey?}`                 | 202 `{job, created: true}`; 200 `{job, created: false}` for a replay |
| `GET {base}/jobs?limit=&cursor=`   |                                                                                                     | `{jobs, next}` newest first; `limit` 1–100, default 20               |
| `GET {base}/jobs?idempotencyKey=`  |                                                                                                     | `{jobs, next: null}`: the one job the key holds, or none             |
| `GET {base}/jobs/{jobId}`          |                                                                                                     | `{job}`                                                              |
| `POST {base}/jobs/{jobId}/cancel`  |                                                                                                     | `{job}`                                                              |
| `GET {base}/jobs/{jobId}/report`   |                                                                                                     | `{url, expiresAt, reportExpiresAt}`                                  |
| `POST {base}/broadcast`            | `{templateId}` or `{title?, body?, data?}`, plus `idempotencyKey, priority?, ttlSec?, collapseKey?` | as `POST {base}/jobs`                                                |

Unknown body fields are a 400. `priority`, `ttlSec` and `collapseKey` are the targeted send's fields.

**Upload.** `{size}` is the file's exact byte length, 1 to 102,401,024. The answer:

```json
{
  "uploadId": "pu_…",
  "url": "https://…",
  "method": "PUT",
  "headers": { "content-type": "text/csv", "content-length": "1234" },
  "expiresAt": 1790000900,
  "usableUntil": 1790086400,
  "maxBytes": 102401024
}
```

- `PUT` the file to `url` with exactly those two headers; both are signed, so another type or length is refused by the bucket. The URL works for 15 minutes.
- A job may name the upload for 24 hours (`usableUntil`), any number of times — the dry run and the job share one upload.
- A channel holds at most 20 **pending** uploads (409 `push_upload_cap`). Pending: no job names it yet, or an unfinished job does. An upload whose jobs have all finished stops counting, and can still be named again inside its 24 hours. `DELETE {base}/uploads/{uploadId}` removes one (row and object) and is refused while an unfinished job reads it (409 `upload_in_use`). Every upload is removed two days after it was issued.
- `uploadId` and `templateId` compare without case; the job stores and answers the id as the platform minted it.
- Replacing the object after a job was submitted fails that job (`upload_changed`): a job reads the object it was submitted with.

**Job.** `idempotencyKey` is the caller's: `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`, unique per channel without case, shared by jobs and broadcasts, kept as long as the job row (30 days after it finished).

- A repeated key with the **same parameters** answers 200 with the job it named the first time — before anything else is checked, so a retry succeeds even after the template or the upload is gone. Nothing is recorded or sent twice.
- A repeated key with **other parameters** (another template, upload, `dryRun` or option) is 409 `idempotency_key_reused`.
- The job keeps the template's text as it was at submit time; a later edit or delete of the template does not change it.

```json
{
  "id": "pj_…",
  "channelId": "push_…",
  "kind": "campaign",
  "dryRun": false,
  "status": "running",
  "error": null,
  "errorDetails": null,
  "cancelRequested": false,
  "idempotencyKey": "launch-1",
  "templateId": "pt_…",
  "uploadId": "pu_…",
  "message": { "title": "Hi {{name}}", "body": "", "data": {} },
  "options": { "priority": "high" },
  "author": "m_…",
  "total": 1200,
  "processed": 500,
  "counts": {
    "resolved": 480,
    "sent": 470,
    "noToken": 15,
    "unregistered": 4,
    "failed": 6,
    "skipped": 5,
    "duplicates": 3,
    "missingVariables": 2,
    "invalid": 0
  },
  "report": null,
  "createdAt": 1790000000,
  "startedAt": 1790000002,
  "finishedAt": null
}
```

- `status`: `queued → running → done | failed`. A cancelled job is `failed` with `error: "canceled"`.
- `total` is the CSV's row count, `null` until the worker counted it; `processed` is rows finished. Counts are **per row (user)**, not per device:
  - `resolved` — rows whose user holds at least one token (`sent + unregistered + failed` in a real job);
  - `sent` — FCM accepted the message for at least one of the user's devices;
  - `noToken` — the user holds no token in the channel;
  - `unregistered` — every device of the user was gone; the tokens are deleted;
  - `failed` — the user holds tokens and none took the message;
  - `skipped` = `duplicates` + `missingVariables` + `invalid` (`invalid-user`, `too-large` and `invalid-value`).
- `errorDetails` is `null` unless the job is `failed`.
- `report`: `null` until one exists, then `{available, expiresAt}`.
- `author`: a member id, or `apikey`.

**Dry run.** `dryRun: true` runs the same job through the same worker and sends nothing: `total`, `resolved`, `noToken` and the three skipped counts are what the real job would start from, and the report lists every row as `resolved`, `no-token` or `skipped`. It is asynchronous like every job — resolving 100,000 rows is 200 token lookups and does not fit a request — and a small one finishes in seconds. A dry run needs no Firebase project and does not count against `push.jobsPerDay`; a channel may run 20 a day (a constant, 409 `push_dry_run_cap`).

**Cancel.** Sets `cancelRequested`; the worker ends the job between two batches (at once when the job is idle). Rows already sent stay sent and are in the report. Cancelling a finished job answers it unchanged. A cancel that arrives during the last batch stops nothing: every row was processed, so the job ends `done`. A broadcast cannot be cancelled between projects — its one or two messages go out in a single run of seconds; a cancel only stops one that has not started (or that is resumed after a crash).

**Report.** A presigned GET (5 minutes) of a CSV, offered for **7 days** from the moment the job finished (410 afterwards):

```
userId,status,reason
0123…,sent,
89ab…,no-token,
cdef…,failed,unavailable
4567…,skipped,duplicate
```

| `status`       | `reason`                                                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sent`         |                                                                                                                                                                                     |
| `no-token`     |                                                                                                                                                                                     |
| `unregistered` |                                                                                                                                                                                     |
| `failed`       | `unavailable` (no verdict, a quota, or out of time: may be retried in a new job) or `rejected` (FCM will not take it, or the channel holds no working key for the device's project) |
| `skipped`      | `duplicate`, `missing-variable`, `invalid-user`, `too-large`, `invalid-value` (the row's value would put a control character into the message where a template may hold none)       |
| `resolved`     | dry run only                                                                                                                                                                        |

- One line per CSV row, in file order. No device token and no Firebase project id is in it.
- A value a spreadsheet would run as a formula (a leading `=`, `+`, `-`, `@`, tab or CR — only an `invalid-user` row can carry one) is prefixed with `'`; control characters are dropped and a value is cut at 128 characters.
- A job that failed before its first batch (`csv_invalid`, `recipients_over_limit`, …) has no report (409 `report_absent`); one that failed later reports the rows it reached. A broadcast has none.

**Submit errors** (`POST {base}/jobs`, `POST {base}/broadcast`, `POST {base}/uploads`):

| Status | `details`                                                    | Meaning                                                                                                                                                      |
| ------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 400    | —                                                            | invalid body                                                                                                                                                 |
| 400    | `{reason: "csv_invalid", csv, line}`                         | the header cannot be read; `csv` is the rule (`user_column_missing`, `token_column`, `header_name`, `duplicate_header`, `empty`, `invalid_utf8`, `quote`, …) |
| 400    | `{reason: "csv_missing_columns", columns}`                   | the template uses variables the header lacks                                                                                                                 |
| 400    | `{reason: "template_has_variables"}`                         | a broadcast message holds a `{{variable}}`                                                                                                                   |
| 400    | `{reason: "push_payload_too_large"}`                         | an inline broadcast message over 4096 bytes                                                                                                                  |
| 401    | `api key required`                                           | apiKey family: no bearer, not this channel's key, or no such push channel                                                                                    |
| 404    | —                                                            | no such template, upload or job; member family: no such channel                                                                                              |
| 409    | `{reason: "idempotency_key_reused"}`                         | the key names a job with other parameters                                                                                                                    |
| 409    | `{reason: "upload_missing"}`                                 | nothing was put to the upload's URL                                                                                                                          |
| 409    | `{reason: "upload_size_mismatch"}`                           | the object is not of the signed size                                                                                                                         |
| 409    | `{reason: "upload_expired"}`                                 | the upload is older than 24 hours                                                                                                                            |
| 409    | `{reason: "push_upload_cap", max: 20}`                       | the channel holds 20 pending uploads                                                                                                                         |
| 409    | `{reason: "upload_in_use"}`                                  | `DELETE …/uploads/{uploadId}`: an unfinished job reads the upload                                                                                            |
| 409    | `{limit: "push.jobsPerDay", value}`                          | the channel's jobs of this UTC day reached the limit; ask for more with a limit request                                                                      |
| 409    | `{reason: "push_dry_run_cap", max: 20}`                      | 20 dry runs this UTC day                                                                                                                                     |
| 409    | `{reason: "push_not_registered"}`                            | the channel has neither a platform registration nor a team key                                                                                               |
| 409    | `{reason: "report_not_ready"}` / `{reason: "report_absent"}` | the job has not finished / finished without a report                                                                                                         |
| 410    | `{reason: "channel_inactive"}`                               | the channel is expired or disabled (a member still reads its jobs)                                                                                           |
| 410    | `{reason: "report_expired"}`                                 | the report is older than 7 days                                                                                                                              |
| 429    | `{retryAfterMs: 500}`                                        | the write slot                                                                                                                                               |
| 503    | `{reason: "push_not_configured"}`                            | the stage has no Firebase project (a dry run is still accepted)                                                                                              |
| 503    | `{reason: "push_sender_unavailable"}`                        | the pool no longer holds the channel's project                                                                                                               |
| 503    | `{reason: "push_storage_unavailable"}`                       | the stage has no bucket for uploads and reports                                                                                                              |

**Why a job failed** (`job.error`, with `job.errorDetails`):

| `error`                 | `errorDetails`                            | Meaning                                                                                                               |
| ----------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `canceled`              |                                           | the cancel route                                                                                                      |
| `csv_invalid`           | `{reason, line}`                          | the file breaks a CSV rule at that record (`no_rows`: a header and nothing else; `missing_columns`); nothing was sent |
| `recipients_over_limit` | `{limit: "push.recipientsPerJob", value}` | more rows than the limit; nothing was sent                                                                            |
| `upload_missing`        |                                           | the object is gone                                                                                                    |
| `upload_changed`        |                                           | the object was replaced after the submit                                                                              |
| `channel_gone`          |                                           | the channel was deleted                                                                                               |
| `channel_inactive`      |                                           | the channel expired or was disabled                                                                                   |
| `not_registered`        |                                           | the channel lost its registration and holds no team key                                                               |
| `sender_unavailable`    |                                           | FCM refused the platform's key, or the pool lost the channel's project: the operator's to fix                         |
| `send_failed`           |                                           | a broadcast no project accepted                                                                                       |
| `stalled`               |                                           | five runs died without finishing it                                                                                   |
| `expired`               |                                           | still unfinished three days after the submit                                                                          |

### Limits

Both are **channel-scope** keys of the limits registry, listed for push channels only (`GET /limits?scope=channel:<id>`) and raised with a limit request like `channel.lifetime` is granted (`docs/decisions.md` _Limit requests_).

| Key                     | Soft   | Hard    | Counts                                                                                                                                                                                            |
| ----------------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `push.recipientsPerJob` | 10,000 | 100,000 | rows of one job's CSV, skipped rows included. Checked by the worker's first pass: a longer file fails the job (`recipients_over_limit`) before anything is sent. No usage is shown.               |
| `push.jobsPerDay`       | 10     | 100     | jobs submitted per channel and UTC day, a broadcast counting as one. Claimed inside the submit's transaction, so concurrent submits cannot pass it (409 `details.limit`). Usage is today's count. |

- A dry run counts against neither; a replayed `idempotencyKey` is answered before the count; a job that failed or was cancelled still counts.
- Code constants no request raises: 20 templates and 20 pending uploads per channel, 20 dry runs per day, 500 rows per batch.

### Broadcast

One FCM message to the channel's **topic**, so the cost is one request whatever the audience.

- **Topic name: `yyt.push.{channelId}`** — also the channel view's `topic` field.
- **Client contract.** After `PUT /push/{channelId}/token` succeeded, the app subscribes its FCM instance to that topic (`FirebaseMessaging.subscribeToTopic`), and unsubscribes on sign-out next to `DELETE …/token`. The platform stores no subscriber list and cannot subscribe a device on the app's behalf: a device that never subscribed receives no broadcast. Topic membership is per app install, not per user; FCM takes up to a day to apply a new subscription.
- The message is `{templateId}` of a template **without variables**, or an inline `{title?, body?, data?}` under the template rules. A `{{variable}}` is refused (400 `template_has_variables`): there is no row to fill it from.
- When the channel has both a platform registration and a team sender key, one message is sent **per Firebase project** (a topic belongs to a project). `total` is the number of projects, `counts.sent` the projects FCM accepted for, `counts.failed` the rest; the job is `done` when at least one accepted.
- A broadcast is a job: same `idempotencyKey` rule, same status route, one job against `push.jobsPerDay`, no dry run and no report. It is not counted in `push_send_stats`.
- `sent` is acceptance by FCM. FCM does not say how many devices a topic reached.
- **A topic is not private.** Anyone who holds the app can subscribe to `yyt.push.{channelId}`: the app's Firebase config is public by design and the topic name is the channel id. So can any other app registered in the same pooled Firebase project — a topic belongs to the project, not to an app. A broadcast must therefore carry **no secret, no personal data and no `data` that grants anything** (a code, a reward, an entitlement): treat it as a public announcement. Content for particular users goes through a campaign or the targeted send, which address device tokens.
- **A topic message is not authenticated to the app either.** What holds is integrity on the sending side — only this API, with the project's key, can send to the topic — not that a received message proves anything about its reader. The app must not grant or unlock anything because a topic message arrived; it re-reads state from its server.

### How a job runs

- **One worker container per stage** (`pushJob`, `reservedConcurrency: 1`). It is the pace of every campaign of the stage: at most 20 requests to FCM are in flight for all campaigns together (one `sendMany`), a few hundred messages a second against a default quota of 600,000 a minute per Firebase project, so a campaign cannot take the targeted sends' share. No pause between batches is added on top; after a batch FCM answered with a quota error the worker waits 5 s before its next batch.
- **Turns.** The worker claims a runnable job of the **channel served least recently**, works on it for at most 60 s plus the batch in flight (always at least one batch; a batch sends for at most 60 s), gives it back and claims the next. Channels alternate whatever each has queued: a channel with many jobs gets one turn between two turns of any other. Inside a channel the job given back longest ago goes first. What a new job or broadcast is guaranteed: it waits for at most **one turn of every other channel that has runnable work** (about two minutes each at worst), plus the turns of its own channel's older jobs — not a fixed time.
- **Lease.** A claim is one conditional update that sets `lease_owner` and `lease_until` (300 s, renewed by every batch). Two invocations never hold one job, and every later write is fenced on the owner.
- **Ending.** The lease is renewed, the report object is written from the batch parts, the row is ended by a statement fenced on the lease (it sets the report's time), and only then are the parts removed. A worker that lost its lease stops at the renewal and writes nothing; a crash before the row write leaves the parts for the next run, one after it leaves parts the lifecycle rule removes.
- **Batch.** 500 CSV rows: one token lookup, the sends (each token with the key of the project that issued it, as the targeted send does), the batch's report rows to S3, then **one statement** that moves the cursor and adds the counts — fenced on the lease and on the cursor it expects. Then the day's `push_send_stats` and the deletion of tokens FCM reported gone.
- **Duplicate window: one batch.** A run that dies after a batch's sends and before its cursor statement leaves the cursor where it was; the next run sends that batch again and nothing else. At most 500 users can receive a campaign message twice, once per crash. Set `collapseKey` when a duplicate would hurt. The report still holds each row once.
- **Time box.** An invocation claims no job after 7 minutes (the function's timeout is 10) and then **invokes itself** when runnable work is left. Resuming re-reads the CSV from the start to rebuild the duplicate set and continues at the cursor.
- **First pass.** Before the first send the whole file is read once: a malformed file or one over `push.recipientsPerJob` fails the job with nothing sent, and `total` is recorded.
- **Between batches** the channel is read again: deleted, expired or disabled ends the job (`channel_gone`, `channel_inactive`); so does `cancelRequested`, unless every row was processed.
- **A broadcast** notes each project it sent to on its row (a hash, never the project id) in the statement that counts it. A rerun skips exactly those, so a crash repeats one message at most even when the channel's projects changed meanwhile.
- **A refused platform key** ends the job (`sender_unavailable`) with the batch's remaining users `failed` / `unavailable`; it is not retried. A refused **team** key fails that project's users (`rejected`) and the platform project's tokens are still sent.
- **Recovery.** A run that hits a database or bucket error gives its job back, counts an attempt and throws; Lambda retries the event after 1 and 2 minutes. A job whose lease ran out unreleased (its worker was killed) counts an attempt too. A batch that moves the cursor clears the count; five failed runs in a row end the job `failed` / `stalled` (`done` when every row had been processed). When nothing is runnable but an unfinished job sits behind a lease, the invocation **waits for that lease** (at most four sleeps, inside its time box) and claims the job, or hands the wait to its next invocation — a killed worker's job resumes about five minutes later without anyone asking. A status read of a job nobody worked on for a minute kicks the worker (once a minute per job), every submit kicks it, and the daily sweep kicks it and fails anything unfinished after three days (`expired`).

## What push does not do

- **iOS.** APNs needs each team's Apple key; out of scope.
- **Devices without Google Play services** get nothing. The app reads over HTTP while it is open.
- **Delivery guarantee.** `sent` means FCM accepted the message. Doze, a force-stopped app, a full FCM queue or an expired `ttlSec` can still drop it. No receipt, no open tracking.
- **Scheduling, segments, a query over players.** A campaign is sent when it is submitted, to the users its CSV lists. A team schedules and selects on its own side.
- **Topics of a team's own.** One topic per channel, the broadcast's.
- **Per-device targeting, token listing or export.** Tokens are platform-internal; no team-facing route returns one.
- **Deduplication of targeted sends.** Two calls are two messages. A campaign job is deduplicated by its `idempotencyKey` and, inside a file, by `userId`; a crashed batch may still repeat (_How a job runs_).
- **Retry of failed recipients.** A job reports them; sending again is a new job with a new file.

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

### Campaign worker, storage and upkeep

- **`pushJob`** is a function of the console stack: one reserved container, 512 MB, 600 s, `PUSH_SSM_PATH` set, two Lambda retries. It is invoked asynchronously only — by `api` on a submit, a cancel and an idle status read, by `expire` once a day, and by itself. Its MariaDB connection is the one `api` gave up (`api` 10 → 9): console stays 12 of the budget, 57 of 60 in all. Self-invocation is allowed explicitly (`RecursiveLoop: Allow`): Lambda's loop detection would otherwise stop a long job's chain.
- **Objects** live in the stack's private bucket (the one site zips are staged in, SSE-KMS): `push-uploads/{channelId}/{uploadId}.csv`, `push-reports/{channelId}/{jobId}.csv`, and `push-reports/{channelId}/{jobId}.parts/{batch}.csv` while a job runs. The bucket's lifecycle rules expire `push-uploads/` after 6 days and `push-reports/` after 8 — an upload may be named for a day and its job may run three more before the sweep fails it, so the rule never removes a file a live job reads; both are part of the stack's template, so a deploy applies them and there is no script to run.
- **Daily sweep** (console `expire`, after the push sweep, five phases, each isolated; log line `push job sweep` or `push job sweep truncated`):
  1. jobs, uploads and objects of push channels that died on this run;
  2. uploads older than 2 days, object first — except one an unfinished job still reads;
  3. jobs unfinished 3 days after their submit → `failed` / `expired`;
  4. finished jobs older than 30 days (their idempotency keys go with them);
  5. the stale count (jobs runnable for an hour or more that no worker claimed) and the kick: when anything is runnable, the worker is invoked.
- A channel delete drains the same rows and both prefixes inline (20 statements of 500 rows, 1,000 objects per prefix); the sweep and the lifecycle take the rest. Templates go with the channel row's purge (a foreign key; at most 20 rows).
- **Digest.** The push section carries the previous UTC day's jobs per channel (`jobs`, `failed`; dry runs left out), five channels at most. Warnings: `push:jobs:failed:{channelId}:{day}` for a channel with a failed job, `push:jobs:sweep:failed:{phase}` for a sweep phase that threw, `push:jobs:expired:{n}` when the sweep failed `n` jobs as expired and `push:jobs:stale:{n}` when `n` jobs had been runnable for over an hour unclaimed — the last two are how a `pushJob` that crashes at every start shows (each is repeated once every day it is true). Campaign sends add to `push_send_stats` like targeted sends (one `calls` per batch), so `push:send:failed:…` covers them too. No new alarm.
- **Log lines** (counts only; no user id, device token or project id): `push job` (one per finished job, the pushJob log group), `push job worker` (one per invocation: `claimed`, `more`), `push job lease expired`, `push job lease lost`, `push job run failed` (error), `push job report failed`, `push job report parts left`, `push upload object left` (api), `push sender refused` (error, by slot label), `push team sender refused`, `push broadcast refused`, `push job kick failed` (api).
- **Grants.** None: `push_templates`, `push_uploads` and `push_jobs` are console's alone, and the worker uses the console account.
- **A stuck job** is visible as `status: "running"` with `processed` not moving. Reading its status kicks the worker; `POST …/cancel` ends it at the next claim. Nothing needs a manual database write.
- **Granting both hard limits to one channel can saturate the worker.** 100 jobs a day of 100,000 rows each is more than one container sends in a day at a few hundred messages a second. Other channels still get every other turn, so they slow down rather than stop, but that channel's own queue grows until jobs expire at three days. Raise one limit or the other for a channel, not both, unless its volume was discussed.

### Rollout order per stage

1. Owner: Firebase project, APIs, key into SSM (_Adding a project_).
2. `scripts/deploy.sh console <stage>` — applies `m0028_push`.
3. `scripts/deploy.sh auth <stage>`, `topic`, `match` — **before the first push channel exists**: their older bundles throw on a `push` row (a 5xx where a 404 belongs) when a caller names a push channel's id.
4. Owner: the state account's grants on `push_tokens` and `push_send_stats`.
5. `scripts/deploy.sh state <stage>` — adds the `pushSend` function (2 reserved containers; state is 8 of the MariaDB budget, 57 of 60 in all).
6. `scripts/deploy-web.sh <stage>`.
7. `node scripts/smoke/push.mjs <docBase> <debugKey> <authBase> <consoleBase>` (dev).

Campaigns (after the above): `scripts/deploy.sh console <stage>` alone — it applies `m0029_push_campaigns`, adds the `pushJob` function, cuts `api` to 9 containers and adds the two lifecycle rules. No grant and no other stack. Then `node scripts/smoke/push-campaign.mjs <docBase> <debugKey> <authBase> <consoleBase>` (dev; it needs the state stack only to register two made-up tokens).

Rolling console back past `m0028_push`: hard-delete the `push` channel rows and their `push_apps` rows first (`rules/deployment.md`).

## Not built yet

Decided in `docs/decisions.md`, tracked in the machine-local backlog:

- **Deferred-match hook** (_Match: deferred mode_ #5) — built 2026-10-06 on the match stack, not deployed: a deferred match channel naming a `pushChannelId` sends each affected member a high-priority data-only `{channelId, matchId, state}` (`services/match/README.md` _Deferred mode_). It reads `push_tokens` and deletes nothing: a token FCM reports unregistered is left to the next targeted send and the 60-day sweep. Its sends are not in `push_send_stats`; each writes one `match push` log line. Bound (_Match: deferred mode_ #7): `proposed`/`expired` messages to one user on one channel are at least 10 s apart (dropped, counted as `outcomes.spaced`, never queued), and a player who declined or let a window close cannot queue again for `acceptTimeoutSec`.
- **Campaigns and broadcast** (#7b, #7c, #9) — the server side is built (_Campaigns_): not deployed, and neither the console SPA nor `yyt push template|job|broadcast` exists yet.
- **Console app notifications** (#10): the app joining the first pool project and one topic per installed catalog app.
- **Client libraries**: no `push` package exists in tslib, csharplib or flutterlib; an app calls the two token routes directly and subscribes to the channel's topic itself (_Broadcast_).
