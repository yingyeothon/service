# User Interfaces

Applies to anything a person looks at: the console SPA (`apps/console-web`), the Go CLI (`cli/`), and the pages the two hand to a browser. The page grammar — which component a page is built from, where its buttons live — stays in [workflow.md](workflow.md); this file is what every user-facing change owes **without being asked**.

## The default checklist

A change is not done until all seven hold. The owner should never have to ask for one of them (2026-09-03: three rounds of corrections on one catalog table — panel below the table, then wrapped rows, then a hover-only tooltip and a row menu pushed out of view — every one of them foreseeable from this list).

1. **It fits the page.** The console body is `maw={1080}` (`components/layout.tsx`). A table whose min-content exceeds that is pinned at min-content on every desktop: it scrolls horizontally, the last column (the row menu) ends up outside the visible area, and Mantine's `ScrollArea` only shows its scrollbar on hover, so nothing tells the user there is more to the right. Every column sits at its content's width, so **a new column is spent from another column's budget** — decide which one gives, and measure.
2. **A row is one line tall.** Columns that must not wrap carry `white-space: nowrap`; the scroll container, never a second line, absorbs a narrow viewport. The one long value gets a single ellipsed line (`display:block` with a px/rem `width` — `max-width` on a `<td>` of an auto-layout table does not hold) and is read in full on demand. **A sentence in a cell has no good ending**: wrapped it makes the row five lines tall, nowrapped it stretches the table past the page — a per-row note is metadata, not a column.
3. **A phone has no hover.** Anything reachable only by hovering does not exist on mobile web, and the console is used from phones (the iOS OTA install flow only makes sense there). Give every hover affordance a tap equivalent: a `Tooltip` for the pointer (`events={{hover, focus, touch: false}}`) and a `Collapse` inside the same cell for the tap, toggled by content that is already on screen. Keep the two mutually exclusive.
4. **Keyboard and assistive tech, from the start.** A disclosure is a real `button` (`UnstyledButton`) with `aria-expanded` and `aria-controls`, not a `tabIndex={0}` span; the visible label leads the accessible name (WCAG 2.5.3 — never a fixed `aria-label` over a label that flips); a control with no text of its own says what it is ("Upload metadata"), never "Metadata of —"; targets clear 24×24 (`paddingBlock` on a one-line button); rows that repeat carry what tells them apart in every control's name.
5. **Tokens, not framework defaults.** Colours and radii come from `apps/console-web/DESIGN.md` through `src/theme.ts`. The first use of a Mantine component the theme does not cover paints in Mantine's own palette — add the `components` entry in the same commit (`Tooltip`, 2026-09-03).
6. **The CLI is the other half of the surface.** Anything the console shows about a resource, `yyt <noun> get/list` should already print — and vice versa: the catalog CLI printed every upload tag for months while the console showed none, which is what started this. When a route's shape changes, `src/types.ts` + `src/api.ts` + the page **and** the CLI command with its `httptest` fake move in one commit. A value people copy (`sha256`, `commit`) must be selectable somewhere: tooltip content is `pointer-events: none`.
7. **Prove it where it runs.** Unit tests pin props and wiring; **jsdom performs no layout**, so `toHaveStyle` only proves the component wrote what it wrote. A claim about width, height, wrapping or overflow needs a browser (recipe below), and after that the `dev` deploy and the owner's own pass.

## Measuring a layout claim

A standalone HTML page with Mantine's computed values (`table-layout: auto`, `td` padding `12px 16px`, 14px/1.25, the real column contents) inside the page's own `maw` wrapper, probed at 420 / 700 / 900 / 1080 / 1280 / 1600:

```bash
google-chrome --headless=new --disable-gpu --no-sandbox \
  --virtual-time-budget=2000 --dump-dom "file://$PWD/repro.html"
```

with the probe writing `getBoundingClientRect()` widths, row heights, `scrollWidth > clientWidth` and `el.scrollWidth > el.clientWidth` (ellipsis) into a `<pre id="out">`. Rendering the repo's own components through esbuild is more faithful still, but a hand-written table is enough to catch a column budget. Record the numbers in the todo entry — they are the only evidence for "it fits".

## Mantine 8 gotchas that cost a round each

- `className="mantine-visually-hidden"` — **no such class ships**. The text renders, and sizes its column with it; use `<VisuallyHidden>`. Grep `node_modules` before trusting a global class name copied from docs.
- `Tooltip` `multiline` is `white-space: normal`, not `pre-wrap`: a multi-line value is flattened in the one place it is meant to be read whole.
- A controlled `opened={false}` does not stop `useHover` updating the tooltip's own state behind it, so releasing the control (back to `undefined`) re-opens it under a resting pointer. Gate `events` too, and clear the guard on `mouseleave`/`blur`.
- `Collapse` keeps its children mounted when closed (`display: none`): they are out of the a11y tree and out of Ctrl+F, but present in the DOM — a test that queries by text will find them.
- `env="test"` renders portals inline, so a tooltip label and an in-cell fold share one `<td>`: query a fold by `role="group"` with its own `aria-label`, never by its text.
- `Text` defaults to a `<p>`; inside a phrasing context pass `component="span"`.
