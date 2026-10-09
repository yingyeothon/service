# Rules Index

Load only the files relevant to the task. After finishing a task, add new lessons to the matching file and update this index if files change.

- [architecture.md](architecture.md) — monorepo layout, stack boundaries (the state stack's two storage shapes, `docs/kvstore.md`), tslib compatibility, `@yyt/push` and the stacks that use it, sample stacks, Go CLI, Go gateway and wire contracts.
- [workflow.md](workflow.md) — per-task completion ritual, todo retirement (docs/rules/local split), plan-first review, phased commits, Console SPA and Go CLI conventions, commit/push policy.
- [ui.md](ui.md) — what every user-facing change owes without being asked: the console's column budget, one-line rows, touch/mobile equivalents for hover, keyboard and assistive tech, theme tokens, CLI parity, browser measurement, and the Mantine 8 traps.
- [testing.md](testing.md) — testable code, fake fidelity (failure points, collation, status assertions, a third-party API behind the injected `fetch`), MariaDB testcontainers, coverage expectations.
- [manual-verification.md](manual-verification.md) — verifying on the `dev` stage, smoke tools, debug-only hooks.
- [deployment.md](deployment.md) — deployment decision flow, stages, domains, SSM secrets, CDN/SPA deploy, static site host (`g.yyt.life`), compatibility-route retirement, stateful-host IP/DNS changes, alarms, the push rollout order and its rollback precondition, the deferred match rollout order (match → console) and its rollback precondition.
- [data.md](data.md) — self-hosted MySQL/Redis account model, MySQL schema/pool/error mapping, Redis ACL quirks, key layout and TTLs, expiry, the kv, leaderboard, limit-request and push tables (CHECK constraints, covering indexes, the limit and claim lock orders, token cap semantics) and the state account's table-scoped grant.
- [security.md](security.md) — identity, tokens, secrets, logging, callback signatures, public-repo defenses, push device tokens and Firebase keys. Policy for contributors: `docs/secrets.md`.
- [serverless-aws.md](serverless-aws.md) — API Gateway WebSocket/httpApi, Lambda, layers, the 10-alarm free-tier budget (ask before adding an alarm), runtime SSM reads (the push pool), S3 lifecycle for the pre-existing buckets, delayed work through EventBridge Scheduler one-time schedules (worst-case cost first).
