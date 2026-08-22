# Repository Instructions

## Project Shape

- `yingyeothon/service`: contest-support services deployed with Serverless Framework 4 on AWS (`ap-northeast-2`, `AWS_PROFILE=yyt`). Four stacks — `services/{auth,console,topic,match}` — plus shared `packages/*`, the console SPA in `apps/console-web`, and a Go CLI in `cli/`.
- Source of truth, in order: `docs/decisions.md` (confirmed product/tech decisions) → `todo/index.md` (progress + next work) → `todo/NN-*.md` (per-area checklists) → `docs/auth-game-contract.md` (JWT contract shared with tslib games).
- Sibling repo `~/git/yyt.life/tslib` (`@yingyeothon/*`) owns game-loop libraries; this repo must stay compatible with its JWT/WebSocket contracts but never duplicates its code.
- Write user-facing docs in Korean; write `rules/` and code comments in English.

## Required Rule Lookup

- Before non-trivial work, open `rules/index.md` and the relevant rule files.
- Keep this file short; reusable lessons go in `rules/`.
- After each completed task: update `todo/index.md` (status table, progress log, next work), tick the checklist in the area doc, and add lessons to `rules/*.md`.

## Essential Commands

- `pnpm install && pnpm -r build && pnpm test` — build + vitest (no Docker needed).
- `pnpm lint && pnpm format:check && pnpm typecheck` — CI gates.
- `scripts/deploy.sh <service> <stage>` — deploy one stack (`dev` for verification, `prod` on request only).
- `scripts/smoke/*.mjs`, `wscat -s bearer -s <jwt>` — manual verification against `dev`.
- `cd cli && go test ./... && go build ./...` — CLI.

## Non-Negotiables

- Decisions in `docs/decisions.md` are settled; change the doc first, then the code.
- Runtime state lives in Upstash Redis (REST) with a `{service}:{stage}:` prefix; durable data lives in the per-service sqlite file on S3 behind the write lock — `rules/data.md`.
- Identity comes only from verified JWT claims / sessions; never log tokens, OAuth codes, or secrets — `rules/security.md`.
- Every task: tests → manual verification on `dev` → three adversarial review subagents → update rules/todo → commit to `main` and push — `rules/workflow.md`.

## Session Start (IMPORTANT)

- **Do NOT look for `.claude/handover.md` in this repo.** On "이어서 진행" / "잔여 작업 진행", go straight to `todo/index.md` → "다음 작업" and start the next unfinished area doc without asking for confirmation.
