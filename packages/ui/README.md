# `@workspace/ui`

Shared React component library for the zero-memory dashboard and docs-facing
product UI.

## Role in the architecture

Interface building blocks only. The package owns visual primitives, composed
dashboard/memory/entity/rules components, shared hooks, and global styles; it
does not fetch data or decide authorization. Apps pass typed data and actions
into these components.

The shadcn configuration uses the `base-vega` style on `@base-ui/react`,
Tailwind CSS v4, React Server Components, CSS variables, and Lucide icons.
Components live under `src/components`, global styles under
`src/styles/globals.css`, and aliases resolve through `@workspace/ui/*`.

## Key exports

- `@workspace/ui/components/*` — shadcn primitives and composed product
  components for auth, dashboard, memories, entities, review, rules, scopes,
  reflections, and settings. Among them:
  - `common/markdown` — the one renderer for narrative text (a memory, a card
    body, notes, reasons, drafts): raw HTML shows as literal text, images never
    load, script and data links render as plain text, external links open in a
    new tab with their domain shown, memory ids become links. Lists and
    previews keep their own compact rendering.
  - `memory/memory-detail`, `board/card-detail`, `entity/entity-detail` — the
    full views of a memory, a card and an entity. Each takes serializable data
    plus slots, so a page and a panel render the same view.
  - `board/card-links` — how a card stands to other cards, grouped by side
    (above, below, related, duplicates), each relation named from the card's
    side with its reason; display-only, the other card's label opens it.
  - `board/board-card-tile` — one card as the board shows it.
  - `board/card-severity` — how much a card matters, as five ticks filled up
    to its level, drawn under the card's label on the tile and the detail.
  - `board/card-type` — why a card's work exists, as the icon most boards use
    for a story, bug, task or spike (a dashed circle when a card has none),
    drawn before the severity ticks on the line under the card's label; the
    detail names the type under that line.
  - `board/board-column-fold` — one column with the cards past the horizon
    folded behind an arrow in the right of its header; the arrow shows only
    when there are such cards, and its hint says how many and why.
  - `settings/connected-agents-panel` — the agents an account approved, one
    row per client with the return address it was approved for, when, and
    when it was last active; Revoke asks once and hands the work to the
    caller.
  - `settings/judge-provider-panel` — the rule-delivery judge of an account:
    a switch and a provider choice that save as they change, and a
    write-only key form; an installed key is named by its provider and last
    four characters only.
  - `panels/panel-strip` — the controlled strip of panels a dialog opens:
    equal-width panels in one snapping row, paged by arrows at the screen
    edges, each with its source and its ×.
  - `entity/entity-edge-list` — an entity's edges as `src —type→ dst` lines.
  - `auth/totp-code-field` — the one field for a code from an authenticator
    app, used wherever a code is typed: six cells, three and three around a
    dash, on shadcn's `input-otp`. Focus moves to the next cell with each
    digit, a paste fills every cell (spaces and dashes in a copied code are
    dropped), the last digit submits by itself, once, and after a refused code
    the cells clear and focus returns to the first. One real input underneath,
    so one-time-code autofill and password managers keep working.
- `@workspace/ui/hooks/*` — shared client hooks such as the mobile breakpoint
  helper.
- `@workspace/ui/lib/*` — class-name utilities, scope formatting,
  instruction-rule formatters, and the Markdown helpers (the remark plugins and
  the link classifier behind `common/markdown`).
- `@workspace/ui/globals.css` and `@workspace/ui/postcss.config` — shared
  Tailwind theme/styles and PostCSS configuration.

## Development

Use the repository's shadcn CLI workflow when adding or inspecting registry
components so changes honor `components.json`:

```sh
bunx --bun shadcn@latest add <component>
```

Check what the CLI wrote before committing: with this monorepo's aliases it
can import the class helper from a stray `cn` npm package (and add that
package as a dependency) instead of `@workspace/ui/lib/utils`, and it can
leave a style-registry class name that nothing defines. A component that uses
an animation the shared stylesheet does not ship (the code cell's blinking
caret) needs its keyframes added to `src/styles/globals.css`.

Run `bun run typecheck`, `bun run lint:strict` and `bun run test:vitest` from
this package, or the corresponding root workspace checks. The unit tests cover
display logic only: pure helpers and components rendered to static markup in
node, with no DOM.
