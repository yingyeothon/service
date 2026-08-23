# Workflow

## Per-task completion ritual

1. Make the change testable and cover new/changed behavior with vitest (or `go test` for the CLI).
2. Manually verify on the `dev` stage with curl/wscat or `scripts/smoke/*` (see `manual-verification.md`).
3. Run three fresh-context subagents to adversarially review the change (correctness, security, operability).
4. Apply the review feedback.
5. Record reusable lessons in `rules/*.md`; update `rules/index.md` if files changed. Update `todo/index.md` (status table, progress log with absolute date, next work) and tick the area checklist.
6. Commit to `main` with an imperative message and push to `origin` (`git@github.com:yingyeothon/service.git`). No PRs unless branch protection appears.

## Documentation discipline

- `docs/decisions.md` is the contract. If implementation forces a change, edit the doc in the same commit and note it in `todo/index.md`.
- Do not leave work in chat only: anything a future session needs must be in `todo/` or `rules/`.
- Commit per coherent unit; never `git add .` when generated files are present. Keep `.gitignore` current.
- Sessions start by reading `todo/index.md` → "Next work"; sessions end by updating the same section.

## Go CLI (`cli/`)

- Every resource command maps 1:1 to a console route; when a route's semantics change (e.g. PATCH partial vs full replace), update the CLI and its `httptest` fake in the same commit. Golden files: `go test ./internal/cmd -update`.
- Releases are tag-driven (`cli/vX.Y.Z`) via `cli/scripts/build-release.sh` + `gh release create`; goreleaser OSS cannot version from prefixed monorepo tags.
