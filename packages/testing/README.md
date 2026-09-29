# @yyt/testing

Test-only helpers the stacks and packages share (`todo/53`, 2026-09-29): the
opt-in integration env loader, the fake clock and constants, the fake
WebSocket transport, the API Gateway event builders and the auth-channel seed.

Consumed **from source** (`exports: ./src/index.ts`, no `dist`): the helpers
change with the tests that use them, and a built copy would go stale between
`pnpm -r build` runs exactly when it matters. Nothing here may be imported
from `src/` of a package or service — only from `test/`.
