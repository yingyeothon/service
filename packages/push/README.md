# @yyt/push

FCM HTTP v1 and the Firebase Management API over `node:crypto` + an injected `fetch` (no `firebase-admin`, no `google-auth-library`), plus the per-stage pool of platform Firebase projects. Decisions: `docs/decisions.md` _Push notifications (Android, FCM)_.

Device tokens, access tokens and service-account contents never reach a log line or an error message: results carry enum codes and HTTP statuses only, and Google's free-text `message` is never passed on.

## Public API

- `parseServiceAccount(json)` → `ServiceAccount` (key held as a `KeyObject`); throws `ServiceAccountError` naming the refused field. `token_uri` must be absent or Google's endpoint.
- `createAccessTokenProvider({serviceAccount, scopes, fetch, clock?, logger?})` → `{get(), invalidate(token?)}` — RS256 assertion → access token, cached until 60 s before expiry, concurrent callers share one exchange. Rejects with `AccessTokenError` (`auth` | `unavailable`).
- `createFcmSender({projectId, tokens, fetch, clock?, sleep?, random?, timeoutMs?})` → `{send(message), sendMany(messages, options?)}`. Outcomes are a `SendResult` union (`sent` | `unregistered` | `invalid` | `quota` | `unavailable` | `auth`), never a throw. `sendMany`: ≤ 500 messages, 20 at a time, 20 s budget, ≤ 3 tries each, results in input order.
- `createManagementClient({projectId, tokens, fetch, …})` → `createAndroidApp`, `getAndroidAppConfig`, `removeAndroidApp` (the platform passes `immediate: true`, except the reconciliation's reversible first step), `undeleteAndroidApp`, `listAndroidApps`. The API assumptions a first real run must confirm are listed at the top of `src/management.ts`.
- `createPushPool({loadSlots, fetch, clock?, logger?, …})` → `slots()`, `bySlot(slot)`, `byProject(projectId)`, `senderFor(serviceAccountJson)`, `skipped()`, `refresh()`. Slot list cached 10 minutes per container; a failed first load is remembered for a minute (`POOL_RETRY_MS`); a malformed slot is skipped, logged by label and listed by `skipped()`; slot labels follow `@yyt/core`'s `PUSH_SLOT_LABEL`, the grammar `@yyt/console-db` stores; an empty pool rejects with `pushNotConfigured()` (503, `isPushNotConfigured`).
- `ssmSlotLoader({path, client})` — `GetParametersByPath` with decryption; the parameter's last name segment is the slot label. `handler.ts` builds the `SSMClient`.
- Fakes: `createFakeGoogle({clock?})` (token endpoint + FCM + Management behind one `fetch`, with `failNext`, `deviceTokens`, `revokeAccessTokens`, `revokeKey`, `appLimit`, `operationPolls`, `failNextOperation`, and the recorded `sent`) and `createFakePushPool({slots?, google?, logger?})` (the real pool over the fake).
