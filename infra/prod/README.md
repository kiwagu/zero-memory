# Production runtime

Containerized runtime for the zero-memory MCP server and web dashboard.
The transcript watcher is **not** part of this stack — it is a client-side
daemon on each developer machine (see below).

## Topology

```
 developer machine(s)                        server host
┌─────────────────────┐        ┌─────────────────────────────────────────┐
│ MCP clients ────────┼──┐     │  reverse proxy (TLS) ── caddy or yours  │
│ (Claude Code, hooks)│  │     │     │         │        │                │
│                     │  ├──►──┼──► zm-server  zm-web   zm-docs          │
│ watcher (systemd    │  │     │   :8787 ──┐  :3100     :3200            │
│ user unit) ─────────┼──┘     │           │      │                      │
└─────────────────────┘        │       Supabase stack (Kong :8000)       │
                               │       auth / postgres+pgvector / rest   │
                               └─────────────────────────────────────────┘
```

- `zm-server` — Elysia MCP server (streamable HTTP + OAuth), embeds queries
  locally (ONNX model cached on the `zm-models` volume, downloaded once).
- `zm-web` — Next.js dashboard (standalone build).
- `zm-docs` — the documentation site (Fumadocs on Next.js, standalone build),
  serving the repository's own `docs/` tree. Public and unauthenticated; it
  reaches nothing else in the stack.
- Supabase — managed separately and reached over the network: a hosted project,
  or a stack you run yourself (self-hosted docker compose or the CLI stack).
  This compose file never runs it and by default does not even share a network
  with it.

## Build & run

```sh
cp infra/prod/.env.example infra/prod/.env   # fill in values
docker compose --project-directory infra/prod up -d --build
```

Or deploy published images instead of building on the host — point
`ZM_IMAGE_PREFIX` at the registry (trailing slash included) and pin
`ZM_IMAGE_TAG` to a released version:

```sh
docker compose --project-directory infra/prod pull
docker compose --project-directory infra/prod up -d --no-build
```

The server and dashboard images are deployment-agnostic: the browser-facing
Supabase URL and key are resolved per request and handed to the browser in the
document, so the same image serves any deployment and changing them is a
restart, not a rebuild. The documentation image deliberately is not: see
"The documentation site" below.

## Isolated production-path rehearsal

Before using a VPS, exercise these exact images, the Caddy edge and OAuth
issuer against the dedicated `zero-memory-review` stack — the one that carries a
clone of live and stays up, rather than the test stack, which resets its database
at every suite run. Stand it up first: `bun --cwd tests/e2e run review:stack`.
The rehearsal's app containers are a separate Compose project
(`zero-memory-prod-review`) on ports 18080/18443, 18787 and 13100, all bound to
`127.0.0.1`; they never attach to the dev/stage database. They deliberately
treat that isolated stack as an **external** database — reached through its
published port, on no shared network — so the rehearsal walks the same path a
hosted Supabase project takes, and the run asserts that no foreign network is
attached at all.

Use an **existing** physical snapshot explicitly. The wrapper deliberately
cannot create a live snapshot, because an agent rehearsal must keep live
read-only:

```sh
bun run prod:rehearse restore "$ZM_SNAPSHOT_DIR/<snapshot>_zm-cluster.tar.gz"
bun run prod:rehearse up
bun run prod:rehearse verify
```

Review URLs:

- MCP/OAuth: `https://zm.localhost:18443/mcp`
- dashboard: `https://memory.localhost:18443/login`
- documentation: `https://docs.localhost:18443/docs`
- Supabase gateway: `https://supabase.localhost:18443`

Caddy uses its internal CA for this stand, so a browser shows a local
certificate warning until that CA is trusted. Automated verification uses the
local-only equivalent of `curl --insecure` and asserts `/healthz`, `/readyz`,
the exact OAuth issuer, the MCP 401 challenge, dashboard and Supabase health.

To review it in a browser instead, trust the CA:

```sh
bun run prod:rehearse trust
```

That exports the stand's root, writes a browser policy carrying it as a trust
**anchor**, and prints one root-owned step you run once.

The reason it takes a policy is worth stating, because the obvious route wastes
a day. On a browser verifying through the Chrome Root Store, importing the CA
into the system trust store with `certutil` does nothing useful: the
certificate manager files it under _intermediate_ certificates and never treats
it as an anchor, so the site keeps returning the same
`ERR_CERT_AUTHORITY_INVALID` and it looks as if the import was ignored.
Measured on this stand: with the CA removed from every NSS database on the
machine, the browser trusts it anyway once the policy is installed. Do not
spend time on the trust databases; a full browser restart is required, since
reloading policies alone does not rebuild trust.

One more trap while the CA is untrusted: clicking through the warning is
per-origin, so the dashboard keeps failing on its calls to the Supabase host
even after you accepted the dashboard's own certificate.

Browsers with their own store (Firefox) are unaffected by the policy — import
the exported certificate there by hand; the command prints its path.

Inspect or stop it without touching the persistent e2e database:

```sh
bun run prod:rehearse status
bun run prod:rehearse down
```

Images can also be built standalone from the repo root:

```sh
docker build -f apps/server/Dockerfile -t zero-memory-server .
docker build -f apps/web/Dockerfile -t zero-memory-web .
docker build -f apps/docs/Dockerfile -t zero-memory-docs .
```

The server and dashboard images bake in no deployment: the browser-facing
Supabase URL and key are read from the environment at runtime and handed to the
browser per request, so one built image serves any instance and a key rotation
is a restart. The documentation image is the exception described next.

## The documentation site

`zm-docs` serves the repository's `docs/` tree over HTTP. It is the one image
here that is **not** deployment-agnostic, and deliberately so: two things a
page must state — where the client archive is downloaded from, and which
instance the reader is told to connect to — are resolved when the site is
BUILT and rendered into static HTML. They therefore arrive as Docker build
arguments (`ZM_CLIENT_BUNDLE_URL`, `ZM_CLIENT_BUNDLE_VERSION`,
`ZM_HOSTED_MCP_URL`, `ZM_HOSTED_WEB_URL`), and changing one is a rebuild, not
a restart. `apps/docs/README.md` documents what each renders; an unset bundle
URL is not a failure — the install page then shows a build-from-source note
instead of a dead button.

Two consequences worth stating before they cost an afternoon:

- **The archive is not in the image unless you put it there.** With
  `ZM_CLIENT_BUNDLE_URL=/files/<name>.zip` the file must be in
  `apps/docs/public/files/` at build time; that folder is committed but its
  contents are not (~36 MB per release).
- **Page uploads are blocked at the edge, and refused behind it.** `/upload`
  writes into the content tree inside the container, which the next deploy
  replaces. Two independent things keep it shut: the Caddy site block (and the
  nginx equivalent) answers `404` for that path, so the write endpoint is
  absent from the public surface; and the action itself refuses every request
  unless the operator sets `ZM_DOCS_UPLOAD_TOKEN`. The edge rule is the one
  that survives an operator setting the token for a local convenience and
  forgetting it — remove it only to author pages over the internet
  deliberately.

## Reaching the Supabase stack

The database lives outside this compose project. These containers reach it over
the network at `SUPABASE_URL` and know nothing else about it, so a hosted
project, a stack on this host and one in another datacentre are the same case —
that is the default, and it needs no docker-network configuration at all
(`host.docker.internal` is mapped to the host gateway for locally published
stacks).

| Supabase deployment                               | `SUPABASE_URL`                            | Extra file                            |
| ------------------------------------------------- | ----------------------------------------- | ------------------------------------- |
| Hosted Supabase project                           | `https://<project-ref>.supabase.co`       | —                                     |
| Stack published on this host (e.g. the CLI stack) | `http://host.docker.internal:<kong-port>` | —                                     |
| Stack in Docker here, addressed by service name   | `http://supabase-kong:8000`               | `docker-compose.supabase-network.yml` |

Only the last row needs the attach overlay, which joins the app containers to
the stack's existing network named by `SUPABASE_DOCKER_NETWORK`
(`supabase_default` for the self-hosted compose stack,
`supabase_network_<project>` for a CLI stack):

```sh
docker compose --project-directory infra/prod \
  -f infra/prod/docker-compose.yml \
  -f infra/prod/docker-compose.supabase-network.yml up -d --build
```

### Mail, if that stack is your own

A **self-hosted** Supabase stack also needs the authentication email templates
pointed at, which is a separate overlay applied to THAT stack rather than to
this compose project — [`docker-compose.supabase-mail.yml`](./docker-compose.supabase-mail.yml)
(it lives here because a self-hosted stack is the only consumer; a hosted
project takes the same HTML pasted into its Auth settings):

```sh
docker compose --project-directory infra/dev/supabase \
  -f infra/dev/supabase/docker-compose.yml \
  -f infra/prod/docker-compose.supabase-mail.yml up -d
```

It points Auth at the exported templates the dashboard serves from `SITE_URL`,
because GoTrue fetches templates over HTTP and cannot read a mounted file. The
SMTP credentials themselves are that stack's `.env`. Mail is a required
deployment step — `docs/getting-started/deployment.mdx` (the mail section)
has the whole chain, and the RUNBOOK's
incident checks cover "mail not arriving".

## Environment

Set in `infra/prod/.env` (see `.env.example` for comments):

| Variable                        | Used by        | Purpose                                                |
| ------------------------------- | -------------- | ------------------------------------------------------ |
| `SUPABASE_DOCKER_NETWORK`       | compose        | Attach overlay only: existing Supabase network         |
| `SUPABASE_URL`                  | server, web    | Supabase API gateway, as seen from the container       |
| `SUPABASE_ANON_KEY`             | server, web    | Public API key (auth flows)                            |
| `SUPABASE_SERVICE_ROLE_KEY`     | server, web    | Privileged key (server-side only)                      |
| `ZM_BIND_HOST`                  | compose        | Backend bind address (default `127.0.0.1`)             |
| `ZM_SERVER_PORT`                | compose        | Host port for the MCP server (container: 8787)         |
| `ZM_PUBLIC_URL`                 | server         | External server URL = OAuth issuer (see TLS)           |
| `ZM_EMAIL`, `ZM_PASSWORD`       | server         | Local-user/stdio credentials; unused by HTTP MCP       |
| `ANTHROPIC_API_KEY`             | server         | Optional model-backed extraction and hygiene           |
| `ZM_WEB_PORT`                   | compose        | Host port for the dashboard (container: 3100)          |
| `NEXT_PUBLIC_SUPABASE_URL`      | web (runtime)  | Supabase URL as seen from the browser                  |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web (runtime)  | Public API key for the browser                         |
| `ZM_DOCS_PORT`                  | compose        | Host port for the documentation (container: 3200)      |
| `ZM_DOCS_UPLOAD_TOKEN`          | docs (runtime) | Enables `/upload`; unset = the endpoint does not exist |
| `ZM_CLIENT_BUNDLE_URL`          | docs (build)   | Client archive the install page links to               |
| `ZM_CLIENT_BUNDLE_VERSION`      | docs (build)   | Label shown beside that download                       |
| `ZM_HOSTED_MCP_URL`             | docs (build)   | MCP endpoint the pages tell readers to connect to      |
| `ZM_HOSTED_WEB_URL`             | docs (build)   | Dashboard the pages link to                            |
| `ZM_SERVER_HOST`                | caddy overlay  | Hostname for the MCP server (= `ZM_PUBLIC_URL`)        |
| `ZM_WEB_HOST`                   | caddy overlay  | Hostname for the dashboard                             |
| `ZM_DOCS_HOST`                  | caddy overlay  | Hostname for the documentation site                    |
| `SUPABASE_HOST`                 | caddy overlay  | Optional hostname to expose Kong on                    |
| `SUPABASE_UPSTREAM`             | caddy overlay  | Upstream for that optional Kong site                   |
| `CADDY_BIND_HOST`               | caddy overlay  | Edge bind address (default `0.0.0.0`)                  |
| `CADDY_HTTP_PORT`/`_HTTPS_PORT` | caddy overlay  | Published proxy ports (default 80/443)                 |

The embedding model cache dir is baked into the server image
(`ZM_MODEL_CACHE_DIR=/models`, named volume `zm-models`).

## Edge / TLS

Two ways to terminate TLS in front of the stack:

1. **Caddy overlay (default)** — [`docker-compose.caddy.yml`](./docker-compose.caddy.yml)
   adds a `caddy` container with automatic certificates (ACME / Let's Encrypt)
   and http→https redirects. Routing lives in
   [`caddy/Caddyfile.template`](./caddy/Caddyfile.template); hostnames come
   from `.env` (`ZM_SERVER_HOST`, `ZM_WEB_HOST`, `ZM_DOCS_HOST`, optional
   `SUPABASE_HOST`).

   ```sh
   docker compose --project-directory infra/prod \
     -f infra/prod/docker-compose.yml -f infra/prod/docker-compose.caddy.yml \
     up -d --build
   ```

   For local / air-gapped testing uncomment `local_certs` in the Caddyfile
   (self-signed via Caddy's internal CA; `*.localhost` hostnames work without
   DNS) and override `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` if 80/443 are
   taken.

2. **Your own gateway** — if you already run nginx/Traefik/…, skip the overlay
   and proxy to the published host ports (`ZM_SERVER_PORT`, `ZM_WEB_PORT`,
   `ZM_DOCS_PORT`).
   Equivalent nginx server blocks: [`nginx/zm.conf.example`](./nginx/zm.conf.example).
   Requirements for any proxy in front of the MCP server: **no response
   buffering** (streamable HTTP answers with `text/event-stream`), WebSocket
   upgrade headers, `X-Forwarded-*` headers, and read timeouts long enough
   for idle streams.

### The issuer invariant

**`ZM_PUBLIC_URL` must equal the external https URL of the MCP server
_exactly_ — scheme, host and port.** The server is an OAuth 2.1 authorization
server whose issuer is `ZM_PUBLIC_URL`: the RFC 8414/9728 discovery documents
(`/.well-known/oauth-authorization-server`,
`/.well-known/oauth-protected-resource/mcp`), all `/oauth/*` endpoint URLs and
the `resource_metadata` URL in `401` challenges embed it verbatim. A mismatch
breaks client authorization. Changing `ZM_PUBLIC_URL` re-issues that metadata
under the new URL — existing OAuth clients must re-register (their stored
issuer/registration no longer match).

### External URLs the browser and email flows need

- **`NEXT_PUBLIC_SUPABASE_URL` (web runtime env)** must be the **external**
  Kong URL (e.g. `https://supabase.example.com`) — the dashboard runs in the
  browser, so a docker-internal or localhost URL will not work. It is read
  from the environment at runtime and handed to the browser per request;
  changing it is a restart, not a rebuild. Expose Kong through the proxy
  (optional site block in the Caddyfile / nginx example) or however you
  already publish Supabase.
- **`SUPABASE_URL` (web runtime env)** remains the Docker-network Kong URL.
  Server components, middleware and the admin client use it instead of
  hairpinning through the public hostname; browser code still uses the
  runtime-served `NEXT_PUBLIC_SUPABASE_URL`.
- **Supabase auth `site_url`** must point at the **external web URL**
  (e.g. `https://memory.example.com`) — GoTrue builds email confirmation and
  password-recovery links from it. Where to set it:
  - Supabase CLI stack: `supabase/config.toml` → `[auth] site_url` (plus
    `additional_redirect_urls`), then `supabase stop && supabase start`;
  - self-hosted docker compose stack: `SITE_URL` (plus
    `ADDITIONAL_REDIRECT_URLS`) in the stack's `.env`, then restart the auth
    (gotrue) container.

### Rollout checklist

| #   | Step   | What                                                                                                                                                                                                                 |
| --- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | DNS    | A/AAAA records for `ZM_SERVER_HOST`, `ZM_WEB_HOST`, `ZM_DOCS_HOST` (and `SUPABASE_HOST` if proxying Kong) → server host                                                                                              |
| 2   | Certs  | Caddy overlay: automatic (ports 80/443 reachable). Own gateway: provision certs for all three hostnames                                                                                                              |
| 3   | Env    | `infra/prod/.env`: `ZM_PUBLIC_URL=https://<ZM_SERVER_HOST>`, `NEXT_PUBLIC_SUPABASE_URL=<external Kong URL>`                                                                                                          |
| 4   | Build  | `docker compose ... up -d --build` (`NEXT_PUBLIC_*` are runtime env — changing them is a restart, not a rebuild)                                                                                                     |
| 5   | Up     | Supabase `site_url` → external web URL; restart auth after changing it                                                                                                                                               |
| 6   | Verify | `GET https://<ZM_SERVER_HOST>/.well-known/oauth-authorization-server` → `issuer` equals `ZM_PUBLIC_URL`; `/healthz` 200; unauthenticated `POST /mcp` → 401 with external `resource_metadata` URL; dashboard signs in |

## Operations

Day-2 operations live in [RUNBOOK.md](./RUNBOOK.md): health probes
(`/healthz` liveness — the container healthcheck; `/readyz` readiness — the
monitoring probe), database backups ([`backup/`](./backup/) script + systemd
timer), key/secret rotation and incident quick checks.

## Watcher (client machines)

The watcher tails local Claude Code transcripts and pushes them to the remote
server, so it runs on every developer machine, not on the host. A systemd
user-unit template is provided in [`watcher.service`](./watcher.service) —
installation steps are in its header comment. Its environment file
(`~/.config/zero-memory/watcher.env`) needs:

```sh
ZM_SERVER_URL=https://zm.example.com/mcp
```

Then authorize once with `zero-memory-watcher login`. The watcher and hooks
reuse the resulting OAuth token store; they never receive Supabase keys or a
user's email/password. Optional chunk, log, and consent settings are
documented in `apps/watcher/README.md`.

## Deployment scripts

The manual walkthrough above is also captured as idempotent scripts in
[`scripts/`](./scripts/) — each covers one stage and can be run alone:

| Script                | Stage                                                                                  | Runs                           |
| --------------------- | -------------------------------------------------------------------------------------- | ------------------------------ |
| `host-bootstrap.sh`   | container runtime, registry login, checkout                                            | on the host, once              |
| `db-provision.sh`     | migration series + service account                                                     | operator machine               |
| `auth-config.sh`      | hosted Auth: SMTP, URLs, mail templates (Management API)                               | operator machine               |
| `db-dump.sh`          | logical backup of an external database + its manifest                                  | on the host, on a timer        |
| `db-restore.sh`       | load such a backup into a schema-only target, and prove it                             | operator machine               |
| `upgrade.sh`          | pull checkout + images, recreate what changed                                          | on the host, every deploy      |
| `db-forward-apply.sh` | apply the pending migration tail, strictly forward (opt-in via `ZM_MIGRATE_ON_DEPLOY`) | on the host, from `upgrade.sh` |
| `verify-instance.sh`  | external acceptance: health, OAuth issuer, TLS, callback origin                        | anywhere                       |
| `deploy-hook.sh`      | forced command that lets a CI key deploy one version                                   | on the host, over ssh          |

Each script names its required environment in its header and refuses to run
without it. `verify-instance.sh` is read-only and safe against a live
instance.

## Continuous deployment (optional)

The shipped workflow can deploy a release to a host by itself: after the
images are published, a `deploy` job connects over ssh and asks the host to
move to that version. It exists only when a target is configured, so a
checkout without one has no deploy stage at all.

On the host, create a key the workflow will use and confine it to a single
action — the forced command means a leaked key can deploy a published
version and do nothing else. It points at the stable path
`/usr/local/bin/zm-deploy-hook` that `host-bootstrap.sh` installs, not into
the checkout: the hook is what updates the checkout, so a path inside it
would not exist on the first deployment.

```sh
ssh-keygen -t ed25519 -f deploy_key -N '' -C 'ci deploy'
printf 'command="%s",no-pty,no-agent-forwarding,no-port-forwarding,no-X11-forwarding %s\n' \
  /usr/local/bin/zm-deploy-hook "$(cat deploy_key.pub)" \
  >> ~/.ssh/authorized_keys
```

In the repository, set:

| Kind     | Name                 | Value                                                  |
| -------- | -------------------- | ------------------------------------------------------ |
| variable | `ZM_DEPLOY_HOST`     | ssh target, e.g. `root@203.0.113.10` — enables the job |
| variable | `ZM_SERVER_URL`      | public MCP URL, for the post-deploy acceptance         |
| variable | `ZM_WEB_URL`         | public dashboard URL, same                             |
| secret   | `ZM_DEPLOY_KEY`      | the private key generated above                        |
| secret   | `ZM_DEPLOY_HOST_KEY` | the host's public key line, pinning its identity       |

Releasing is then a version bump: `version` in the root `package.json` is
the release lever — publishing a tree whose version has no tag yet cuts that
tag, which builds the images, which deploys them, which verifies the
result.
