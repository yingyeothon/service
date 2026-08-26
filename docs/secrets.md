# Secrets and Infra Identifiers

**This repository is public. Treat every commit, branch, and PR as world-readable.**

Read this before your first commit. `CONTRIBUTING.md` requires it; the git hooks enforce it.

## What must never enter git

| Class                            | Examples                                                                 | Where it lives instead                                    |
| -------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| Credentials                      | MySQL/Redis passwords, OAuth client secrets, session secrets, debug keys | `local/env/<service>.<stage>.env` (gitignored) → SSM      |
| Infra identifiers                | stateful hostname/IP, database names, MySQL/Redis account names          | private ops repo `yyt-stateful`; refer to it by name only |
| Work notes that may cite either  | `todo/`                                                                  | machine-local, gitignored                                 |
| Generated artifacts with secrets | `local/deploy/*` (SSM logs, `debug-key.dev`), `.serverless/`, `.env*`    | gitignored                                                |

Allowed in git: public service domains (`*.yyt.life`), the bucket name `yyt-service-<stage>`, SSM parameter **names**, placeholders (`<stateful-host>`, `<database>`), and the fixed test fixture `0123456789abcdef…`.

Identifiers are treated as secrets because the stateful host is reachable from the internet; a leaked name is a target.

Not secrets, on purpose: team, project and resource **ids** (`team_…`, `prj_…`, `ca_…`) and the CLI context file `.yyt.json` (`{"team","project"}`) that carries them. They only mean something to a logged-in member of that team, so they may sit in a game repository next to `pubspec.yaml`. Prefer **ids** in a committed `.yyt.json`: a team's name is also its join key (there is no team listing), so publishing it invites join spam.

## Where secrets live

1. **`local/env/<service>.<stage>.env`** — one file per service × stage (`console|auth|topic|match` × `dev|prod`), layout in `local/env.example`, issued by `yyt-stateful`. Mode 600, directory 700.
2. **SSM SecureString** `/yyt-service/<stage>/<service>/{mysql-host,mysql-port,mysql-database,mysql-user,mysql-password,redis-host,redis-port,redis-user,redis-password,redis-key-prefix}`, console-only `console/redis-acl-{user,password}` (the participant-credential issuer, optional — set both or neither, and **removing it needs an explicit `aws ssm delete-parameter`**, which `bootstrap-ssm.sh` does when the local env file no longer carries the pair: `put` never deletes, so a stale parameter would be re-baked into the Lambda by the next deploy), plus stage-wide `debug-key` (dev), `github-client-*`, `admin-github-logins`, `session-secret`, `gateway-token`, `gateway-ws-url`, and dev-only `auth/debug-mysql-{user,password}`.
3. **Lambda environment** — `serverless.yml` resolves `${ssm:...}` at deploy time. Values are baked into the function configuration; rotation therefore requires a redeploy.
4. **CI** (when needed) — GitHub _environment_ secrets only. Never repo files.

## Scripts

| Script                             | Purpose                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/bootstrap-ssm.sh <stage>` | `local/env/*.<stage>.env` → SSM. Values pass through a 0600 temp file (never argv), env files are parsed (never sourced), `umask 077`, names-only log in `local/deploy/`. Keeps the existing dev `debug-key` and `gateway-token` across re-runs (set the env var to rotate; then redeploy console **and** the gateway). |
| `scripts/get-env.sh <stage>`       | SSM → `local/env/` on a new machine.                                                                                                                                                                                                                                                                                    |
| `scripts/migrate.sh <stage>`       | Sources `local/env/console.<stage>.env` and runs `prisma migrate deploy`. The `mysql://` URL (it embeds the password) is assembled only inside `prisma.config.ts` — never pass it via argv, echo it, or export a `DATABASE_URL` into shells or logs.                                                                    |
| `scripts/local-identifiers.sh`     | Builds gitignored `local/identifiers.txt` (grep patterns for host/DB/account names) used by the hooks. Rerun after any credential change.                                                                                                                                                                               |

## Defenses (all required)

- `.gitignore`: `local/*` (except `README.md`, `env.example`), `.env*`, `.envrc`, `todo/`, `.serverless/`.
- `scripts/git-hooks/pre-commit`: refuses secret-bearing paths, lines matching `local/identifiers.txt`, and runs `gitleaks protect --staged`.
- `scripts/git-hooks/pre-push`: refuses pushes whose tree tracks secret paths or `todo/`, greps the pushed range against `local/identifiers.txt`, runs `gitleaks detect` over the range.
- CI `secrets-scan`: `gitleaks detect` over full history with `.gitleaks.toml`.
- `pnpm install` sets `core.hooksPath=scripts/git-hooks`; `gitleaks` must be installed. **Never use `--no-verify`.**
- The identifier patterns themselves are not in the repo; without `local/identifiers.txt` the hooks warn, so generate it first.

## Code rules

- Never log tokens, OAuth codes, `state`, passwords, or request bodies. Driver errors are reduced to codes (`mysql ER_…`, `redis NOPERM`) before logging; HTTP responses never contain driver messages.
- Secrets are shown once on create/rotate; API tokens are stored hashed.
- Console's writer DB credentials reach the auth Lambda only on `dev` and only with `--param debugHooks=1`.

## Rotation

1. Issue new credentials in `yyt-stateful`; update `local/env/*.env`.
2. `scripts/bootstrap-ssm.sh <stage>` and `scripts/local-identifiers.sh`.
3. Redeploy **every** stack of that stage (`scripts/deploy.sh <service> <stage>`).
4. Revoke the old credentials.

## If something leaks

1. Rotate the credential first (rotation is the only real fix).
2. Rewrite history (`git filter-repo --replace-text` / `--invert-paths`), force-push, and ask GitHub support to purge cached views; notify anyone with clones.
3. Add the leaked shape to `.gitleaks.toml` or `local/identifiers.txt` and prove the hook blocks it with a throwaway staged file.

History note: on 2026-08-22 `main` was rewritten to drop `todo/` and every host/DB name that had been committed earlier.
