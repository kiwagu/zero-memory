# docs

The public documentation site: a [Fumadocs](https://fumadocs.dev) app on
Next.js that renders the repository's own `docs/` tree.

## Where the content lives

Pages are markdown (`.mdx`) files under the repository-root `docs/` folder —
not inside this app. The same files are read by contributors in the repo and
served by the site, so there is exactly one copy of every page.

- **Frontmatter**: every page sets `title` and `description`.
- **Navigation**: a `meta.json` per folder lists its pages in order; a folder's
  `title` there names it in the sidebar.
- **Images**: served from `public/img/` and referenced as `/img/<name>.png`.
  A page marks a shot it still needs with a comment:
  `{/* screenshot: name.png — what to capture */}`.

## Screenshots

A full-screen shot is presented inside a browser window the site draws — title
bar, then an address bar linking to that screen on the live dashboard. Wrap the
markdown image; do not pass it as a prop, or it loses the image pipeline that
gives it dimensions and optimisation:

```mdx
<Screenshot path="/memories">

![What the screen shows](/img/dashboard-overview.png)

</Screenshot>
```

**Capture full screens at 1920×961, not 1920×1080.** The chassis is 119px tall
(`CHROME_HEIGHT` in `components/screenshot.tsx`), so chrome plus capture
composes to a round 1920×1080.

Shoot a **1097×549 viewport at a 1.75 device pixel ratio** — 175% (`CAPTURE` in
the same file) — not the full size at ratio 1. The page then lays out as if the
window were ~1100 wide, so text and controls read large enough for a
documentation page, while the file still lands on 1920 real pixels wide.

The chrome is scaled by the same 1.75: it stands in for a browser window, and a
real window zoomed to 175% has a 175% title bar too — drawn at 1:1 beside a
magnified page it reads as a sticker rather than a window. Every chrome
dimension is a natural browser measurement times the scale, so changing the
scale moves both together (and the viewport in the capture spec with them).

The frame's zoom button opens the **whole window** — chrome included — at the
capture's own size on a wide display, scaling it down in proportion on a
narrower one.

**Panel crops stay unwrapped.** A cropped card or tile is not a whole screen, and
framing it as a window would say otherwise.

Two ways to produce a frame:

- **By hand** — start the test contour and seed the showcase account
  (`cd tests/e2e && bun run e2e:stack && bun run demo:seed`), sign in at
  http://localhost:3102, size the viewport to 1097×549 at a 1.75 device pixel
  ratio, and save into `public/img/`. Never shoot a personal working corpus:
  memory content, scope slugs and provenance carry private detail, and these
  images are committed. The showcase account exists so a shot can be real
  without being private — see `tests/e2e/scripts/curate-showcase.ts`.
- **Automatically** — `cd tests/e2e && bun run e2e:screenshots` recaptures the
  frames tagged `@docs-shot` in
  `tests/e2e/src/web/docs-screenshots.e2e.spec.ts`. Ordinary suite runs never
  touch the images. If a frame has been hand-cropped, drop its test rather than
  letting the two overwrite each other.

`source.config.ts` points Fumadocs at `../../docs`; `bun run typecheck` and
every build regenerate the `.source/` bindings from it.

## Running it

```bash
bun run dev     # http://localhost:3200
bun run build
bun run start
```

## Addresses the build supplies

Two things a page must state are deployment data, not prose: where the client
bundle is downloaded from, and which instance the reader is told to connect to.
Both are resolved at BUILD time by `lib/client-bundle.ts` and rendered through
the MDX components registered in `lib/mdx-components.tsx`
(`<ClientBundleDownload />`, `<ClientBundleInstall />`, `<HostedConnectCommand />`,
`<HostedMcpEndpoint />`, `<HostedDashboardLink />`), so the archive can move
between hosts without a documentation edit.

| Variable                   | Effect                                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZM_CLIENT_BUNDLE_URL`     | The archive the install page links to: an absolute URL, or `/files/<name>.zip` served by this site. **No default** — unset renders the build-from-source note instead of a dead button. |
| `ZM_CLIENT_BUNDLE_VERSION` | Optional label shown beside the download.                                                                                                                                               |
| `ZM_HOSTED_MCP_URL`        | The MCP endpoint the page documents (defaults to the published instance).                                                                                                               |
| `ZM_HOSTED_WEB_URL`        | Its dashboard (defaults likewise).                                                                                                                                                      |

```bash
ZM_CLIENT_BUNDLE_URL=https://downloads.example.com/zm/zm-bundle-0.18.1.zip \
ZM_CLIENT_BUNDLE_VERSION=0.18.1 bun run build
```

**Serving the archive from this site.** Until it has a home of its own, drop the
file into `public/files/` and point the variable at it — the path keeps working
wherever the site is deployed:

```bash
cp ~/…/zm-bundle-0.18.1-linux-x86_64.zip apps/docs/public/files/
ZM_CLIENT_BUNDLE_URL=/files/zm-bundle-0.18.1-linux-x86_64.zip \
ZM_CLIENT_BUNDLE_VERSION=0.18.1 bun run build
```

`public/files/` is committed but its contents are not: the archives are ~36 MB
build artifacts that change every release, so whoever builds the site puts the
current one there. With a site-served path the page drops its `curl` line — a
path is not something `curl` can fetch — and the download button carries the
file instead.

If this app is ever containerized, note that `output: 'standalone'` does NOT
copy `public/` into the bundle: the image has to copy it explicitly (see
`apps/web/Dockerfile`), or `/files/…` answers 404 while the page looks fine.

A value that is neither an http(s) URL nor a site-root path — a bare relative
path, `//host/…`, anything with `..` — is treated as unset. The page never
invents an address, and service addresses (`ZM_HOSTED_*`) must stay absolute.

## Uploading a page from the site

`/upload` writes a markdown file straight into the `docs/` tree, so the site
and the repository never hold two different versions of a page. It is **off**
unless the operator sets `ZM_DOCS_UPLOAD_TOKEN`; the form then requires that
token on every submission.

Uploads are validated before anything touches the disk: the path must be
relative, at most two folders deep and end in `.md`/`.mdx`, and the body must
open with a frontmatter block that sets a title and a description. An existing
page is only replaced when the submitter explicitly asks for it.

A new page still needs a line in its folder's `meta.json` to appear in the
sidebar — the upload form says so on success.
