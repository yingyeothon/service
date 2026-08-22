# Testing

- Core logic (matching, lock, token issue/verify, state machines) must not import AWS SDK or fetch directly; inject `Kv`, `S3Client`, `fetch`, and clock so unit tests run without network or Docker.
- Redis: test against `createMemoryKv()` (in `packages/upstash`), which must mirror Upstash semantics used in code (NX/EX, TTL expiry via injected clock, list/set ops, eval for lock release). Add a contract test suite that runs the same cases against the fake and, optionally (env-gated), a real Upstash dev instance.
- S3: `aws-sdk-client-mock`. Provider HTTP (GitHub/Google): undici `MockAgent`.
- No task is complete without tests for the new behavior. Target vitest coverage ≥80% lines / ≥70% branches per package, like tslib.
- WebSocket handlers: test the pure handler functions with synthetic API Gateway events; test the poster with a fake transport that records `send`/`drop`.
- CLI: `httptest` servers + golden output files.
- `createMemoryKv` does not run Lua: `eval` pattern-matches the scripts this repo ships (currently only compare-and-delete). Adding a new script means adding a matcher in `memoryKv.ts` and a case in `kvContractTests` so the real-Upstash run (env-gated by `UPSTASH_TEST_URL`/`UPSTASH_TEST_TOKEN`) keeps the fake honest.
- Inject `clock` _and_ `sleep` into `withLock` in tests; advancing the fake clock inside `sleep` makes timeout tests deterministic without timers.
- `aws-sdk-client-mock` + a tiny in-memory "bucket" (Map of key → {body, etag}) is enough to test ETag-conditional downloads; assert on `commandCalls(GetObjectCommand).length` to prove the cache is used.
