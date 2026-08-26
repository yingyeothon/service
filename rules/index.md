# Rules Index

Load only the files relevant to the task. After finishing a task, add new lessons to the matching file and update this index if files change.

- [architecture.md](architecture.md) — monorepo layout, stack boundaries, tslib compatibility, package API conventions.
- [workflow.md](workflow.md) — per-task completion ritual, todo/doc maintenance, commit/push policy.
- [testing.md](testing.md) — testable code, fakes for Redis/S3, coverage expectations.
- [manual-verification.md](manual-verification.md) — verifying on the `dev` stage, smoke tools, debug-only hooks.
- [deployment.md](deployment.md) — deployment decision flow, stages, domains, SSM secrets.
- [data.md](data.md) — self-hosted MySQL/Redis account model, MySQL schema/pool/error mapping, Redis ACL quirks, key layout and TTLs, expiry.
- [security.md](security.md) — identity, tokens, secrets, logging, callback signatures, public-repo defenses. Policy for contributors: `docs/secrets.md`.
- [serverless-aws.md](serverless-aws.md) — API Gateway WebSocket/httpApi, Lambda, layers, the 10-alarm free-tier budget (ask before adding an alarm), S3 lifecycle for the pre-existing buckets.
