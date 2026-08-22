# local/ — machine-local configuration (gitignored)

Everything here except this README and `env.example` is ignored by git and protected by the pre-commit/pre-push hooks. Never force-add anything from this directory.

- `env/<service>.<stage>.env` — MySQL/Redis credentials per service × stage (`console|auth|topic|match` × `dev|prod`). Layout: `env.example`. Source: the private `yyt-stateful` ops repo.
- `identifiers.txt` — grep patterns for host/DB/account names (`scripts/local-identifiers.sh`), consumed by the git hooks. Regenerate after any credential change.
- `deploy/` — stage-specific deploy parameters / generated artifacts that must not be public (e.g. SSM bootstrap logs, debug keys).
- Recovery on a new machine: re-issue credentials via `yyt-stateful` or pull them from SSM (`scripts/bootstrap-ssm.sh` uploads `local/env/*.env` to `/yyt-service/{stage}/{service}/*`; see `todo/09-storage-migration.md`).
- If versioning of these files is ever needed, use a separate **private** repo — never this one.
