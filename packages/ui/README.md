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
  reflections, and settings.
- `@workspace/ui/hooks/*` — shared client hooks such as the mobile breakpoint
  helper.
- `@workspace/ui/lib/*` — class-name utilities, scope formatting, and
  instruction-rule formatters.
- `@workspace/ui/globals.css` and `@workspace/ui/postcss.config` — shared
  Tailwind theme/styles and PostCSS configuration.

## Development

Use the repository's shadcn CLI workflow when adding or inspecting registry
components so changes honor `components.json`:

```sh
bunx --bun shadcn@latest add <component>
```

Run `bun run typecheck` and `bun run lint:strict` from this package, or the
corresponding root workspace checks.
