# yingyeothon/service

Contest-support backend for the Yingyeothon hackathon: per-channel OAuth login (`auth`), operations console (`console`), WebSocket topic broadcast (`topic`), and FIFO matchmaker (`match`), deployed with Serverless Framework 4 on AWS `ap-northeast-2`. Game loops live in the sibling [`tslib`](https://github.com/yingyeothon/tslib) packages; this repo only has to stay compatible with their JWT/WebSocket contracts.

> **Public repository.** Secrets and infrastructure identifiers never enter git. Read [`docs/secrets.md`](docs/secrets.md) before committing — the git hooks and CI enforce it.

## Layout

- `packages/*` — shared libraries (`core`, `redis`, `console-db`, `jwt`, `http`, `ws`)
- `services/{auth,console,topic,match}` — one Serverless stack each
- `apps/console-web` — console SPA; `cli/` — Go CLI `yyt`
- `docs/` — decisions, contracts, secrets policy; `rules/` — engineering rules for contributors and agents
- `local/` — machine-local config (gitignored); `todo/` — machine-local work tracker (gitignored)

## Commands

```bash
pnpm install && pnpm -r build && pnpm test      # build + vitest (no Docker)
pnpm lint && pnpm format:check && pnpm typecheck # CI gates
YYT_IT=1 pnpm test                               # opt-in integration tests against dev MySQL/Redis
scripts/deploy.sh <service> <dev|prod>           # deploy one stack
cd cli && go test ./... && go build ./...        # CLI
```

## Documentation

- [`docs/decisions.md`](docs/decisions.md) — settled product/technical decisions (change the doc before the code)
- [`docs/secrets.md`](docs/secrets.md) — secrets, identifiers, hooks, rotation
- [`docs/auth-game-contract.md`](docs/auth-game-contract.md) — JWT contract shared with game stacks
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — workflow and mandatory checks
- [`rules/index.md`](rules/index.md) — detailed engineering rules
