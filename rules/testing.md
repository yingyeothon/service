# Testing

- Core logic (matching, lock, token issue/verify, state machines) must not import drivers, AWS SDK or fetch directly; inject `Kv`, `ConsoleDb`, `fetch`, and clock so unit tests run without network or Docker.
- Redis: test against `createMemoryKv()` (in `packages/redis`), which must mirror the Redis semantics used in code (NX/EX, TTL expiry via injected clock, list/set ops, eval for lock release). `kvContractTests` runs the same cases against the fake and, with `YYT_IT=1`, the real dev Redis.
- MySQL: repositories are tested against a fake `Db` that records SQL/params and feeds canned rows (`packages/console-db/test/fakeDb.ts`); `createMysqlDb` itself against a fake `mysql2` pool; `createMemoryConsoleDb` must pass the same contract cases. `YYT_IT=1` adds a real round-trip on the dev DB (unique ids, cleaned up in `afterAll`). Integration tests must open one connection per suite — the host allows few.
- S3: `aws-sdk-client-mock`. Provider HTTP (GitHub/Google): undici `MockAgent`.
- No task is complete without tests for the new behavior. Target vitest coverage ≥80% lines / ≥70% branches per package, like tslib.
- WebSocket handlers: test the pure handler functions with synthetic API Gateway events; test the poster with a fake transport that records `send`/`drop`.
- CLI: `httptest` servers + golden output files.
- `createMemoryKv` does not run Lua: `eval` pattern-matches the scripts this repo ships (currently only compare-and-delete). Adding a new script means adding a matcher in `memoryKv.ts` and a case in `kvContractTests` so the real-Redis run (`YYT_IT=1`) keeps the fake honest.
- Inject `clock` _and_ `sleep` into `withLock` in tests; advancing the fake clock inside `sleep` makes timeout tests deterministic without timers.
- Provider HTTP via undici `MockAgent`: wrap `undici.fetch` with `{ dispatcher: agent }` and inject it as the provider's `fetch`; serve Google's JWKS through the same mock so `createRemoteJWKSet` (jose `customFetch`) runs the real path. Mint test id_tokens with `generateKeyPair("RS256")`.
- Assert on distinctive sentinel strings (e.g. `c0de-secret-zz`) when checking that a secret never appears in a response — short words collide with legitimate error text.
