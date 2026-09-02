# @yyt/console-web

Operator console SPA (React + Vite + react-router). Served under `/ui/` on the
console API host (`console{-dev}.yyt.life/ui/`) so API root paths (`/events`,
`/channels`, …) never collide with SPA routes and the `__Host-` session cookie
applies to both. Published to S3 + CloudFront by `scripts/deploy-web.sh <stage>` (distribution owned by `services/console`).

## Pages

- `/ui/` — sign-in / role notice, installer downloads.
- `/ui/teams`, `/ui/teams/:team[/projects|members|discussions|history|settings]`,
  `/ui/teams/:team/discussions/:id` — member+; what a page offers follows the
  caller's standing in the team (`role` of `GET /teams/{id}`): owner/member
  write, a seatless platform admin reads, a pending requester sees the name.
- `/ui/teams/:team/projects/:prj[/channels|catalog|assets|versions|issues|settings]`,
  `…/channels/new`, `…/issues/:n` — member+. Channels, catalog apps and asset
  bundles are created here.
- `/ui/channels` (every channel across the caller's teams), `/ui/channels/:id`,
  `/ui/catalog/apps/:id`, `/ui/assets/:id` — member+; detail pages are addressed
  by id and carry a breadcrumb from the view's `teamName`/`projectName`.
  `/ui/catalog` and `/ui/assets` redirect to `/ui/teams`.
- `/ui/tokens` — any signed-in member (tokens carry the role at use time).
- `/ui/members` — admin; also the installer-app setting.
- `/ui/events`, `/ui/events/:id` — public for waiting/opened/closed events; drafts,
  date votes, comments, page history/diff and owner/admin controls when signed in.

User text (team/project descriptions, discussions, issues, comments, event and
proposal bodies) is markdown rendered by `src/components/Markdown.tsx`
(react-markdown + remark-gfm + rehype-sanitize: no raw HTML, no images,
`http(s)` links only). The CloudFront distribution adds a CSP header
(`services/console/serverless.yml`, `WebHeadersPolicy`); the built `index.html`
must stay free of inline scripts for `script-src 'self'` to hold.

## Design system

`DESIGN.md` (this directory) holds the token system — colours, type scale,
radius, spacing — and `src/theme.ts` maps it onto Mantine. Every page is one
of four archetypes built from `src/components/{PageHeader,Section,DataTable,
FilterBar,ResourceDrawer,RowMenu}.tsx`:

- **List** — `PageHeader` with the one filled `New <noun>` button (opens a
  right `ResourceDrawer`), an optional `FilterBar`, a `DataTable`.
- **Detail** — `Crumbs`, `PageHeader` (`Edit` opens the drawer; its foot is
  the danger zone; further actions sit in the overflow menu), optional route
  tabs, `Section`s.
- **Form page** — only `…/channels/new`.
- **Utility** — Home, App login.

Rules the kit enforces: the header renders before data (skeleton title);
destructive actions confirm in a modal whose button repeats the verb
(`src/lib/confirm.ts`); success is a notification (`src/lib/notify.ts`),
errors stay inline; at most one filled button per viewport; every table
scrolls inside `Table.ScrollContainer`.

## Development

```sh
# proxies everything outside /ui/ to the dev API (default https://console-dev.yyt.life)
YYT_DEBUG_KEY="$(cat ../../local/deploy/debug-key.dev)" pnpm dev
```

- `VITE_API_PROXY` overrides the proxy target (scheme included). The built SPA
  always calls the API on its own origin: the session cookie is `__Host-`, so a
  cross-origin API can never authenticate. `vite preview` has no proxy, so only
  anonymous pages work there.
- React StrictMode double-invokes effects in dev, so every page fetches twice
  — expected, not a bug.
- The proxy rewrites `Origin` to the target so the API's same-origin CSRF check
  accepts cookie mutations from `localhost:5173`. `YYT_DEBUG_KEY` adds
  `x-debug-key` to `POST /debug/login` only; the key never reaches the page.
- The proxy refuses requests whose `Origin`/`Referer` is not the dev server
  itself, so other sites cannot use it as a CSRF or debug-login oracle.
- Mint a session from the browser console (the proxied stack must be deployed
  with `--param debugHooks=1`):

  ```js
  await fetch("/debug/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: "dev-admin", githubId: -901, role: "admin" }),
  });
  location.reload();
  ```

## Build / test

`pnpm build` → `dist/` (base `/ui/`). `pnpm test` (vitest + jsdom),
`pnpm typecheck`. Lint/format run from the repo root.
