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
  - `panels/panel-strip` — the controlled strip of panels a dialog opens:
    equal-width panels in one snapping row, paged by arrows at the screen
    edges, each with its source and its ×.
  - `entity/entity-edge-list` — an entity's edges as `src —type→ dst` lines.
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

Run `bun run typecheck`, `bun run lint:strict` and `bun run test:vitest` from
this package, or the corresponding root workspace checks. The unit tests cover
display logic only: pure helpers and components rendered to static markup in
node, with no DOM.
