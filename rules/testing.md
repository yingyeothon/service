# Testing

- Core logic (matching, lock, token issue/verify, state machines) must not import AWS SDK or fetch directly; inject `Kv`, `S3Client`, `fetch`, and clock so unit tests run without network or Docker.
- Redis: test against `createMemoryKv()` (in `packages/upstash`), which must mirror Upstash semantics used in code (NX/EX, TTL expiry via injected clock, list/set ops, eval for lock release). Add a contract test suite that runs the same cases against the fake and, optionally (env-gated), a real Upstash dev instance.
- S3: `aws-sdk-client-mock`. Provider HTTP (GitHub/Google): undici `MockAgent`.
- No task is complete without tests for the new behavior. Target vitest coverage ≥80% lines / ≥70% branches per package, like tslib.
- WebSocket handlers: test the pure handler functions with synthetic API Gateway events; test the poster with a fake transport that records `send`/`drop`.
- CLI: `httptest` servers + golden output files.
