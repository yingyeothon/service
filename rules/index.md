# Rules Index

Load only the files relevant to the task. After finishing a task, add new lessons to the matching file and update this index if files change.

- [architecture.md](architecture.md) — monorepo layout, stack boundaries, tslib compatibility, package API conventions.
- [workflow.md](workflow.md) — per-task completion ritual, todo/doc maintenance, commit/push policy.
- [testing.md](testing.md) — testable code, fakes for Redis/S3, coverage expectations.
- [manual-verification.md](manual-verification.md) — verifying on the `dev` stage, smoke tools, debug-only hooks.
- [deployment.md](deployment.md) — deployment decision flow, stages, domains, SSM secrets.
- [data.md](data.md) — sqlite-on-S3 write lock, Redis key layout and TTLs, expiry/backup.
- [security.md](security.md) — identity, tokens, secrets, logging, callback signatures.
- [serverless-aws.md](serverless-aws.md) — API Gateway WebSocket/httpApi, Lambda, layers, cost guards.
