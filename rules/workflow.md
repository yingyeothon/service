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

## Console SPA (`apps/console-web`)

- `pnpm -r build` now runs `vite build`; `pnpm lint`/`typecheck` cover `.tsx` (type-aware ESLint via `projectService`). SPA tests run under the root `pnpm test` (`vitest.config.ts` projects include `apps/*`) but are excluded from the coverage thresholds on purpose.
- When a console route changes shape, update `src/types.ts` + `src/api.ts` and the affected page in the same commit (same rule as the CLI).
- Every route lives in `src/routes.tsx` with the `NAV_ITEMS` path that guards it; `test/routes.test.tsx` proves each guard resolves, so a new page that forgets its nav item fails in CI rather than on a user's screen. Items that must guard without appearing in the menu use `hidden: true`.
- `ModalsProvider` must sit **inside** `QueryClientProvider` and the router: `modals.open` renders its children in the provider's portal, and a modal that queries or navigates crashes otherwise (found when the version-links modal was the first `modals.open` user). A tab that opens modals closes them on unmount (`modals.closeAll()`), or the modal outlives the list it reloads.
- `useAction.run` returns `undefined` on error; a call whose success is _also_ `undefined` (a 204) must map success to a sentinel (`?? null`, `return true`) before deciding what to do next, and never read `act.error` inside the same closure — it is the value from the render that created the closure, not the one `run` just set.
- What a page may do follows the caller's standing in the team (`useTeamStanding` → `GET /teams/{id}.role`), not the platform role: a seated platform admin writes like any member, a seatless one only reads (`secret: true` routes answer 403), so "delete team/project" is gated on `owner || standing === "admin"`, never on `me.role`.

## Go CLI (`cli/`)

- Every resource command maps 1:1 to a console route; when a route's semantics change (e.g. PATCH partial vs full replace), update the CLI and its `httptest` fake in the same commit. Golden files: `go test ./internal/cmd -update`.
- Releases are tag-driven (`cli/vX.Y.Z`) via `cli/scripts/build-release.sh` + `gh release create`; goreleaser OSS cannot version from prefixed monorepo tags.
