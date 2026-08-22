# Contributing

## Non-negotiable: secrets policy

This repository is **public**. You must read and follow [`docs/secrets.md`](docs/secrets.md) before your first commit:

- No credentials, hostnames, database names, or account names in code, docs, tests, examples, or commit messages.
- Keep secrets in gitignored `local/env/*.env`; upload with `scripts/bootstrap-ssm.sh`.
- Run `pnpm install` (installs the git hooks) and have `gitleaks` on `PATH`; generate `local/identifiers.txt` with `scripts/local-identifiers.sh`.
- Never use `git commit/push --no-verify`. A blocked hook means the change is wrong, not the hook.
- If you leaked something: rotate first, then rewrite history (see `docs/secrets.md`).

## Setup

```bash
pnpm install            # also sets core.hooksPath=scripts/git-hooks
scripts/get-env.sh dev  # needs AWS_PROFILE=yyt; or copy env files from yyt-stateful
scripts/local-identifiers.sh
pnpm -r build && pnpm test
```

## Workflow per change

1. Read `docs/decisions.md`; if the change conflicts with it, update the doc in the same commit.
2. Write tests first or alongside (`vitest`; fakes for Redis/MySQL, no Docker). Coverage gates: 80% lines / 70% branches per package.
3. Verify on `dev` (`scripts/deploy.sh <service> dev`, `scripts/smoke/*`). `prod` only on explicit request.
4. Pass `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`.
5. Record reusable lessons in `rules/*.md`.
6. Commit to `main` with an imperative subject; the pre-commit/pre-push hooks must pass.

## Conventions

- TypeScript ESM, Node 22. `create*` factories over classes; options objects; no `process.env`/`console` inside `packages/*`.
- Documentation is written in English, concise, facts only.
- See `rules/index.md` for architecture, data, security, testing, and deployment rules.
