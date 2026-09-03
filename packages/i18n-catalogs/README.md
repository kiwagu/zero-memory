# @workspace/i18n-catalogs

Flat message catalogs and the translator every localised surface shares. A
catalog is a JSON file of `key → string` with `{name}` placeholders; the
translator returns the key itself when a string is missing, so a gap is visible
instead of blank. `bun src/validate.ts` (wired into `lint`) fails when a domain
ships different key sets across its locales, so a half-translated catalog
cannot land.

- `.` — the manifest: `SUPPORTED_LOCALES` (`en`, `es`), `MAIL_LOCALES`,
  `CATALOG_MANIFEST`, locale guards, `resolveLocaleFromAcceptLanguage`, and the
  shared `createTranslator`.
- `./web` — the dashboard catalog: async per-locale loader (a static switch so
  the bundler can resolve each chunk) plus `createWebTranslator`.
- `./mail` — the outgoing-mail catalog: synchronous loader, because mail is
  rendered by the template export script and by the server, never in a browser
  bundle.

`MAIL_LOCALES` is deliberately a subset of `SUPPORTED_LOCALES`: authentication
mail is exported to static HTML for Supabase Auth, which serves one template
per type with no knowledge of the recipient's language, so it ships English
only. Localising mail is adding the locale to `MAIL_LOCALES` and its catalog
file — the templates themselves take strings as props and do not change.
