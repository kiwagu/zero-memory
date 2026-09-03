# @workspace/email

Every message this product sends, written once. There are two senders and they
are different planes: **Supabase Auth** sends the authentication mail (signup
confirmation, password recovery, address change, invitation) over SMTP — we only
give it templates — while **our own code** sends product mail, the weekly digest
first. Both render from the components here, so the two can never drift into
looking like different products.

- `MailLayout` — the shell: shape, palette, footer.
- `AuthNotice` — the one body all four authentication messages use (a single
  action plus the raw link for clients that strip buttons). They differ only in
  strings, so there are four exported artifacts but one piece of markup;
  duplicating the layout per template is what this package exists to prevent.
- `DigestMail` — the weekly summary. Counts only, deliberately: a summary that
  quoted memories would move private content into an inbox and a mail
  provider's logs.
- `renderAuthTemplate` / `renderDigest` — the render boundary. Authentication
  mail renders with GoTrue's placeholders where a product mail renders real
  values; that substitution is the whole trick that lets one component tree
  serve both senders.
- `IMailSender` + `ResendMailSender` — the product-mail port and its transport.
  Narrow on purpose: one message, one recipient. No scheduling or recipient
  selection lives here — that belongs to whatever feature decides to send.

## Strings

Copy lives in the mail catalog (`@workspace/i18n-catalogs/mail`), not in the
components: templates take strings as props. Mail ships **English only**, and
that is a property of the delivery mechanism rather than a shortcut — Supabase
Auth serves one static template per type and knows nothing about the recipient's
language. Localising mail means adding the locale to `MAIL_LOCALES` and its
catalog file; the templates do not change, and the exporter already writes one
file per locale.

## Exporting

```bash
bun run --cwd packages/email mail:export   # render → apps/web/public/email-templates/
bun run --cwd packages/email mail:check    # fail if the export or the wiring drifted
```

One artifact, three consumers — because Auth reads templates differently
depending on how it is hosted:

| Consumer                             | How it gets the template                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Supabase CLI stacks (dev, e2e stand) | `[auth.email.template.*] content_path` in `config.toml`; the CLI serves the file to Auth internally |
| Self-hosted stack                    | `GOTRUE_MAILER_TEMPLATES_*` — a path under `SITE_URL`, where the dashboard serves the same file     |
| Hosted Supabase project              | the same HTML, pasted into the project's Auth settings                                              |

That is why the export lands in the dashboard's static assets: GoTrue **fetches
templates over HTTP** and cannot read a mounted file, so something has to serve
them, and the dashboard already runs at `SITE_URL`. The files carry no secrets —
Auth substitutes the variables at send time.

Two properties the gates hold, both learned the hard way:

- **Placeholders are asserted as exact substrings.** A template that swallowed
  `{{ .ConfirmationURL }}` still renders a valid-looking email and would ship a
  dead link to every new user.
- **HTML is rendered minified.** `pretty: true` reflows long paragraphs and will
  split a placeholder across lines (`{{ .Email\n }}`), which at best leans on Go
  template whitespace tolerance.

`mail:check` also verifies that each stack's `config.toml` and the self-hosted
mail overlay point at the exported file and carry the catalog's subject, so a
subject retyped into config cannot quietly diverge from the body it belongs to.
It runs as part of this package's `lint`, which is why `turbo.json` here turns
caching **off** for that task: the check reads files outside the package
(`apps/web/public/`, both `config.toml`s, the overlay), and Turbo would key a
cache hit on package files alone — replaying a stale pass over drifted wiring is
exactly the failure this gate exists to prevent.
