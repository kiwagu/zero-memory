# Operations runbook

Day-2 operations for a deployed zero-memory stack: health probes, backups,
key/secret rotation and incident quick checks. Deployment itself is covered
in [README.md](./README.md).

## Health probes

| Endpoint   | Meaning                                                                              | Consumer                                          |
| ---------- | ------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `/healthz` | **Liveness** — the server process answers. No downstream checks.                     | Container `HEALTHCHECK` (baked into the image)    |
| `/readyz`  | **Readiness** — downstreams reachable. `200` when Supabase answers, `503` otherwise. | External monitoring / load-balancer health probes |

`/readyz` response shape:

```json
{ "ok": true, "checks": { "supabase": true, "embedder": "cold" } }
```

- `checks.supabase` — `GET {SUPABASE_URL}/auth/v1/health` with the anon key,
  2 s timeout. `false` flips `ok` to `false` and the status to `503`.
- `checks.embedder` — warm-state of the local embedding pipeline: `ready`
  after the first embed, `cold` before it. Informational only: the model
  loads lazily, so `cold` is a normal post-boot state and never fails the
  probe (and probing never triggers a model download).

Keep the container healthcheck on `/healthz`: readiness flapping (say, a
Supabase restart) must not make Docker kill an otherwise healthy server.

## Backups

Two deployments, two procedures, and they are **not** interchangeable. Which
one applies is decided by a single question: can you reach the database's
files?

| Your database                                     | Portable artifact                   | Tool                                                   |
| ------------------------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| A managed project (no shell, no volume, no exec)  | logical dump you hold yourself      | [`scripts/db-dump.sh`](./scripts/db-dump.sh)           |
| A cluster on this host (its container and volume) | physical base backup of the cluster | [`scripts/zm-cluster.sh`](../../scripts/zm-cluster.sh) |

Run one of them, not both: the second is redundant rather than safer.

### Managed project — logical dump

The platform owns the physical layer. Its snapshots and point-in-time recovery
are better than anything assembled here, and a base backup is not merely
discouraged but impossible — there is no container to exec into. What the
platform does not hand you is an artifact **you** hold: one that survives
losing the account, that can be carried to a different provider, and that
somebody has actually restored. That is what this job produces.

```sh
SUPABASE_DB_URL=… infra/prod/scripts/db-dump.sh
```

- **Data only** — accounts (`auth.users`, `auth.identities`) plus the
  application's own schemas (`public`, `partitions`). No schema, no roles: those
  come back from the migration series, the same one CI applies and the only
  description of the schema that is ever reviewed. A dumped schema would be a
  second, unreviewed copy of it that fights the platform's managed roles on the
  way back in.
- **Its manifest is the oracle.** Next to every `<stamp>_zm-data.sql.gz` sits a
  `<stamp>_zm-data.manifest.json` with per-table row counts read back **out of
  the file**, the schema watermark, size and sha256. Counts taken from the
  artifact rather than from the server are what let a restore be checked
  exactly, instead of "it looked about right".
- **Retention** — `ZM_DUMP_KEEP` artifacts (default 14), manifests pruned with
  their files. A failed run prunes nothing, so a bad night never costs a good
  backup.
- **Off-site** — with `ZM_DUMP_REMOTE` set, the retention window is mirrored
  over rsync/ssh after a successful run. The remote is a mirror, so retention is
  expressed once; give that storage its own provider-side snapshots, because a
  mirror faithfully reproduces a deletion too.
- **Dead-man switch** — with `ZM_DUMP_PING_URL` set, a successful run pings it.
  Alert on the ping _stopping_: a backup timer that quietly stops firing is the
  failure this whole section exists to prevent, and it is invisible in every
  other probe. A failed ping never fails the job.
- **Failure ping** — with `ZM_DUMP_PING_FAIL_URL` set (monitors usually expose
  it as the ping URL plus `/fail`), a failed run says so immediately instead of
  waiting for the dead-man window to expire. For a daily job those are hours
  apart, and the failure is easiest to diagnose the moment it happens. A run
  that fails also exits non-zero, so `systemctl status zm-dump` and
  `systemctl --failed` show it too.
- **Scheduling** — [`backup/zm-dump.timer`](./backup/zm-dump.timer) +
  [`backup/zm-dump.service`](./backup/zm-dump.service); install steps are in the
  unit headers. The unit's `EnvironmentFile` holds `SUPABASE_DB_URL`, a
  credential the serving stack itself never has — mode `0600`, and it joins the
  rotation list when that password changes.

Consistency, stated honestly: the corpus is read first and the account tables
after it, in separate passes, so an account created mid-run is still captured
while the reverse order would have produced rows with no account to own them.
A dump is therefore _self-consistent for recovery_ rather than a single
transactional snapshot; the restore checks for the one interleaving that would
matter (orphaned profiles).

#### Restore drill (managed)

A backup you never restored is a hope, not a backup.

1. **Is the artifact whole?** Re-runnable on any file, any time:

   ```sh
   infra/prod/scripts/db-dump.sh verify <stamp>_zm-data.sql.gz
   ```

   It reads the stream back (a truncated file still gzips), requires pg_dump's
   completion trailer, refuses an artifact carrying no accounts or no memories,
   compares the sha256 against the manifest and prints the per-table counts.

2. **Restore it somewhere else — never over a serving database.** The target is
   a database with the schema and _nothing else_, and its service account must
   **not** be provisioned first: the accounts arrive inside the artifact.

   ```sh
   supabase db push --db-url "$TARGET_DB_URL"          # schema, from the migrations
   SUPABASE_DB_URL="$TARGET_DB_URL" ZM_RESTORE_YES=1 \
     infra/prod/scripts/db-restore.sh <stamp>_zm-data.sql.gz
   ```

   It refuses a target whose schema watermark differs from the artifact's,
   refuses one that already has accounts, lifts and re-adds the foreign keys by
   the owning role's own authority (a managed `postgres` is not superuser, so
   `--disable-triggers` and `session_replication_role` are not available), and
   runs the whole load as one transaction — a failure leaves the target exactly
   as it was.

3. **Read the verification block, not the exit code.** Every table is compared
   against the manifest, orphaned profiles must be zero, and the embedding count
   is reported: rows can come back while the vectors — the expensive part of
   this corpus — do not.

4. **Real disaster recovery** is the same two commands aimed at a new project,
   followed by pointing `SUPABASE_URL` and the keys of the stack at it. Mind
   that a new project means new JWT material: every session and MCP token dies
   at once and clients re-authenticate. OAuth client registrations survive as
   long as `ZM_PUBLIC_URL` does not change.

### Cluster on this host — physical snapshot

Daily physical snapshot of the whole Postgres cluster, taken **inside** the
db container (no client tools needed on the host, no downtime):

- script: [`scripts/zm-cluster.sh`](../../scripts/zm-cluster.sh) `snapshot` — an
  ONLINE physical base backup of the whole cluster (the database keeps
  serving), written as one gzipped tar with a timestamp-first name and
  retention pruning (`ZM_SNAPSHOT_KEEP`, default 14). Restores whole, into the
  same Postgres major version; the same tool's `clone-to-e2e` /
  `clone-to-review` restores one into the test or the review stack;
- scheduling: [`backup/zm-snapshot.timer`](./backup/zm-snapshot.timer) +
  [`backup/zm-snapshot.service`](./backup/zm-snapshot.service) — install steps
  in the unit headers (daily, randomized start).

Container name (`LIVE_DB`): `supabase-db` for the self-hosted
docker compose stack, `supabase_db_<project>` for a Supabase CLI stack.

#### Restore drill (physical)

Run this periodically, for the same reason as the managed one above.

A snapshot is a **physical base backup**: one gzipped tar of the whole cluster
directory, not a logical dump. So it restores whole, into the same Postgres
major version, by replacing a data directory — `pg_restore` and
"restore one table into a scratch database" do not apply to it at all. If you
ever need to undo a single bad `DELETE`, take a logical dump of that table at
that moment; this format is for whole-cluster recovery, deliberately.

1. **Is the archive whole?** These are the same two assertions the snapshot
   command makes at write time, re-run on an older file:

   ```sh
   gzip -t <snapshot>_zm-cluster.tar.gz
   tar tzf <snapshot>_zm-cluster.tar.gz | grep -qx backup_label && echo "base backup ok"
   ```

   A truncated stream still gzips, so only reading it back proves anything;
   a missing `backup_label` means it is not a usable base backup.

2. **Restore it into another stack — never over the live one.** In this repo
   that is the review stack (the test stack works too, but its next suite run
   resets it back to migrations + fixtures), and the whole procedure is a single
   command:

   ```sh
   scripts/zm-cluster.sh clone-to-review "$ZM_SNAPSHOT_DIR/<snapshot>_zm-cluster.tar.gz"
   ```

   It stops the target database, replaces its data directory wholesale from
   the tar in a throwaway container (restoring ownership `postgres:postgres`
   and mode `700`, without which the server refuses to start), starts it,
   waits for `pg_isready`, bounces the stack's Kong so it re-resolves the
   upstream, and then verifies the result: memory and user counts, the
   migration watermark, and **zero orphaned profiles**. That last check is the
   one that matters — a plain row count cannot tell a real clone from live
   data sitting next to the target's own accounts.

3. **Read the verification line, not just the exit code.** A drill counts as
   passed when the counts match the source cluster's and the schema watermark
   is the expected migration.

4. **Real disaster recovery** is the same file-level replace aimed at the
   production database container instead: stop `zm-server`, stop the db
   container, replace its data directory from the tar (same ownership and
   mode), start it, wait for `pg_isready`, bounce Kong, start `zm-server`,
   then check `/readyz`. Exact commands live in the header of
   [`scripts/zm-cluster.sh`](../../scripts/zm-cluster.sh).

## Key & secret rotation

Every secret here has a **consumer list**, and rotation is safe exactly to the
extent that the list is complete. Start from this table; the procedures below
only expand it.

| Secret                     | Who holds a copy                                                                                           | Restart? | Proof it worked                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------ |
| Database password          | the provisioning step and the backup job — **not** the serving stack                                       | no       | provisioning re-runs clean; `/readyz` never dips |
| Publishable (anon) key     | `infra/prod/.env` → zm-server and zm-web                                                                   | recreate | the served page carries the NEW key              |
| Secret (service-role) key  | `infra/prod/.env` → zm-server and zm-web                                                                   | recreate | budget renders AND scope members show emails     |
| JWT signing key            | nobody copies it; it is verified through the published key set                                             | no       | tokens keep working (see below)                  |
| Service-account password   | `infra/prod/.env` (`ZM_PASSWORD`)                                                                          | recreate | the stdio entrypoint still signs in              |
| `ANTHROPIC_API_KEY`        | `infra/prod/.env` → zm-server                                                                              | recreate | new `ingest_log` rows get `processed_at`         |
| A human account's password | nothing on the server — but every session that account holds                                               | no       | see "What a password change does to clients"     |
| Mail-provider API key      | the operator's environment file and the Auth configuration it is pushed into — nothing on the serving host | no       | a password reset arrives at a real address       |
| Container-registry token   | the host's container credential store (`docker login`)                                                     | no       | a pull succeeds AFTER the old token is revoked   |
| Deployment-checkout URL    | the checkout's own `.git/config` on the host, when the URL embeds a token                                  | no       | `git pull --ff-only` in the checkout succeeds    |
| Platform management token  | nothing between runs — minted per run, revoked after                                                       | no       | the Auth configuration step runs clean           |
| Deploy key                 | the CI secret and the host's `authorized_keys`                                                             | no       | a deployment runs end to end                     |

Before rotating anything, check the mode of the file most of this table points
at: `infra/prod/.env` is created by copying the example, so it inherits a
world-readable mode unless someone sets one — while the backup job's env file,
which holds strictly less, is documented at `0600`. `chmod 600` it. A rotation
is the natural moment to notice, because it is when the file is edited.

The one that surprises people is the first row: the running server never sees
the database password. It talks to the API gateway with keys, so rotating the
database password touches only the scripts that connect to Postgres directly —
provisioning and backups. There is nothing to restart, and no window.

### Managed project — where each rotation happens

- **Database password** — rotated in the provider's console, then updated in
  the operator's own environment file and in the backup job's
  `/etc/zero-memory/backup.env`. Re-run the provisioning step: it applies no
  new migrations and connects with the new credential, so a clean run is proof
  the password works. It proves that and nothing more — the service-account
  step is **create-only** and reports `already exists — nothing to do` on an
  existing account, so provisioning never re-asserts a password. Watch
  `/readyz` throughout — it should never move.
- **A browser-facing key rotation is not proved by anything working.** While
  the old key is still enabled — which is the whole point of creating the new
  one alongside it — every check stays green whether or not the new key was
  ever rolled out: health, sign-in and mail all pass on the old one. Creating a
  key and rolling a key look like one action in a console flow, and nothing in
  between reports the difference. The only honest proof is to read the key the
  dashboard actually hands the browser:
  `curl -fsS <dashboard-url>/login | grep -o 'sb_publishable_[A-Za-z0-9_-]*' | sort -u`
  — it must print the new key and only the new key. That covers the browser
  half. The SERVER half is proved by deleting the old key and re-running the
  acceptance: `/readyz` pings the Auth health route with the key the server
  holds, and that route does validate it (measured: a wrong or absent key
  answers 401), so a green `/readyz` with the old key gone means the server is
  genuinely on the new one. Before the deletion, green only means _some_ valid
  key — which the old one still is.
- **Publishable and secret API keys** — the secret key has TWO consumers and
  they fail differently: the server reads the service-role-only tables with it
  (a bad key breaks the budget outright), while the dashboard's own admin
  client uses it only to resolve member emails and **degrades silently to raw
  user ids** instead of failing. Check both, or half the rotation goes
  unverified. Create the new key **alongside** the old one, roll it through the consumers, and only then delete the old one.
  The provider supports both existing at once, which is what makes this a
  zero-downtime rotation rather than a window. Deleting is irreversible.
- **JWT signing keys** — the one rotation whose last step is time-gated, and
  therefore the one that gets left half-done. Promoting the standby is
  instant; retiring the previous key has to wait out the access-token lifetime,
  so the work stops with the new key in use and the old key **still trusted** —
  which is the exact state the rotation existed to end. Nothing complains: with
  both keys published every check passes, so the omission is invisible until
  someone reads the key set. Schedule the revocation when you promote; do not
  rely on remembering it.

  On the signing-keys system, rotation promotes a
  standby key while the previous one stays trusted, so **nobody is signed
  out**: already-issued tokens keep verifying until they expire naturally, and
  new ones are signed with the new key. Check which system the project is on
  before planning anything: a project still on the legacy shared JWT secret
  behaves the opposite way — every session dies the moment it changes, which is
  the maintenance-window case described for the self-hosted stack below.

### What a password change does to MCP clients

Measured, not assumed (on an isolated stack, with two live sessions on one
account):

| Action                                        | The session that made the change | Every other session  |
| --------------------------------------------- | -------------------------------- | -------------------- |
| Password changed by an administrator          | —                                | refresh **rejected** |
| Password changed by the user in the dashboard | keeps working                    | refresh **rejected** |

So a password change silently revokes every other session's refresh token,
including the ones MCP clients and watchers hold. The break does **not** arrive
immediately: their current access token keeps working until it expires (one
hour by default), so what you see is a wave of failures spread over that window
rather than an outage at the moment of the change — which is exactly why it
gets misdiagnosed as something else.

After changing an account's password, re-authenticate everything that signed in
as it: `zero-memory-watcher login` on every watcher host, and re-authorize the
MCP connection in each editor. OAuth client registrations survive, because the
issuer (`ZM_PUBLIC_URL`) did not change — only the sessions are gone.

### Self-hosted stack — Supabase API keys and JWT secret

The self-hosted stack ships rotation utilities in
[`infra/dev/supabase/utils/`](../dev/supabase/utils/):

- `rotate-new-api-keys.sh` — regenerates the opaque API keys
  (publishable/secret) **without** touching the JWT key pair;
- `add-new-auth-keys.sh` — regenerates the asymmetric JWT key pair and the
  opaque keys from `JWT_SECRET`;
- `generate-keys.sh` — full bootstrap, including a new `JWT_SECRET`.

(The Supabase CLI stack uses fixed development keys — treat it as dev-only.
None of this applies to a managed project, which has no such stack to rotate
in: see the section above.)

**Consequence chain — the keys are seeded everywhere.** Rotating
`ANON_KEY`/`SERVICE_ROLE_KEY` invalidates every place they were copied to:

| Consumer  | Where the key lives                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| zm-server | `infra/prod/.env` (dev: `apps/server/.env`, root `.env`)                                                                                                                        |
| zm-web    | `infra/prod/.env` — including `NEXT_PUBLIC_SUPABASE_ANON_KEY`, which is read at **runtime** and handed to the browser per request, so the container is recreated, never rebuilt |

Rotation order:

1. Rotate keys in the Supabase stack `.env` (utils above), restart the
   Supabase stack.
2. Update `infra/prod/.env` (`SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`).
3. `docker compose --project-directory infra/prod up -d --force-recreate
zm-server zm-web` — `restart` alone does **not** re-read the env file, and
   nothing here needs a rebuild: one image serves any deployment, which is also
   why a host running published images can rotate at all.

   Pass the checkout revision explicitly when recreating by hand. `/healthz`
   reports it, and it comes from an exported variable that only the deploy
   script sets — so a bare `compose up` leaves it empty:
   `ZM_CHECKOUT_SHA="$(git rev-parse --short HEAD)" docker compose …`. The
   stack serves either way; it just stops being able to say which checkout it
   is running from, which is exactly the fact you want visible during a
   rotation. Running the deploy script instead also sets it, but that pulls the
   checkout and the images as well — more moving parts than a secret swap
   needs.

4. Verify: `/readyz` returns 200; dashboard signs in; an MCP client lists
   tools.

For a local dev checkout, steps 2–3 collapse into
`bun scripts/seed-env.ts --force` (re-reads keys from `supabase status`).

**JWT secret rotation here is a bigger hammer than on a managed project:**
with a shared symmetric secret every issued token becomes invalid at once —
all Supabase sessions and **every OAuth-issued MCP access token**. There is no
standby key to keep the old ones verifying, so this is a maintenance window,
not a rolling change. All MCP clients re-authenticate (client registrations
survive because the issuer `ZM_PUBLIC_URL` did not change); run
`zero-memory-watcher login` again on watcher hosts and have dashboard users
sign in again. Then run the full order above — API keys are derived from the
JWT material, so they rotate too.

### ANTHROPIC_API_KEY

Used only by the server-side extractor (`ingest_conversation`). Rotation is
an env swap with zero data impact:

1. Put the new key into `infra/prod/.env` (dev: root `.env`, then
   `bun scripts/seed-env.ts` mirrors it into `apps/server/.env`).
2. Recreate zm-server (`docker compose --project-directory infra/prod up -d
--force-recreate zm-server`) — env-only change, no rebuild, and `restart`
   would not re-read the file.
3. Verify: send a chunk (or wait for the watcher) and check new
   `ingest_log` rows get `processed_at` set.

Nothing else consumes the key — web, watcher and hooks never see it.

### Operator and delivery credentials

None of these reach the serving containers, so rotating one cannot take the
instance down — it fails later, in a step nobody is watching at the time. Each
is rotated the same way: create the replacement, prove it, revoke the old value
only then.

- **Mail-provider API key** — create the new key, put it into the operator's
  environment file, re-run the Auth configuration step so the platform stores
  it, then trigger a password reset to a real external address and confirm it
  arrives. Auth keeps its own copy of this secret, so changing the operator's
  file alone changes nothing — this is the one on this list that silently
  breaks registration.
- **Container-registry token** — log the host in again with the new token
  (`docker login <registry> -u <user> --password-stdin`) and pull the pinned
  tag; `upgrade.sh` with no argument redeploys the current pin and pulls on the
  way. A stale token never disturbs a running stack — it breaks the next
  deployment. Note what a successful pull does and does not prove: while both
  tokens are valid it proves only that the stored credential works, and the old
  one still does. Revoke the old token first, THEN pull again — that is the
  step that distinguishes a swapped credential from an untouched one. (And
  check the packages are actually private before treating any pull as proof: a
  public image pulls with no credential at all.)
- **Deployment-checkout URL** — when the clone URL embeds a token, that token
  lives in the checkout's own `.git/config` on the host and nowhere else.
  Rotate it with `git -C <checkout> remote set-url origin <new-url>`, then
  `git -C <checkout> pull --ff-only`. Missing this one is invisible until a
  deployment tries to update the checkout.

  **Assume it is the same credential as the registry token until you have
  checked.** One access token easily covers both — pulling images and cloning
  the deployment checkout — and then a rotation that only re-runs the registry
  login looks complete while quietly disarming the other consumer. The two also
  need _different_ rights: package read alone authenticates the registry but
  not a git operation on a private repository, so a replacement issued for the
  registry cannot serve the checkout even if someone remembers to paste it
  there. Give each consumer its own credential with its own rights; the failure
  this prevents surfaces at the next deployment, long after the rotation is
  believed finished.

  The failure is at least honest: `upgrade.sh` updates the checkout as its
  first step and aborts on any error, so a broken checkout credential stops the
  deployment before it touches a container. The old containers keep serving.

- **Platform management token** — used only to push the Auth configuration from
  an operator machine. A clean run is the whole proof, and here that proof is
  honest by construction: the step reads its environment on every invocation,
  with no daemon and no cache in between, so a clean run used the token you
  just supplied and nothing else. It must carry **write** on the project's auth
  configuration — the step PATCHes it. A token minted read-only, which is the
  instinct for something that only "pushes config", fails with 403.

  **It cannot usefully be narrowed further, and this was measured rather than
  assumed.** On a token scoped to the single project, granting the documented
  permission for this endpoint — auth, read and write — still fails with 403;
  only granting every permission on that project succeeds. The refusal blames
  "your account", which sends you looking at member roles, where there is
  nothing to find. And since the set that actually works is undocumented, any
  narrower one found by trial rests on unspecified behaviour and would break
  silently later.

  So do not store this credential at all. Mint one scoped to the project with
  the shortest offered lifetime, run the step, revoke it, and leave the
  variable empty in between — the step is run by hand every few months, and the
  guard on the missing value says exactly this. A secret that does not exist
  between uses needs no rotation and belongs on no consumer list.

- **Deploy key** — the private half is a CI secret, the public half sits in the
  host's `authorized_keys` behind a forced command. Add the new public key
  first, swap the CI secret, run one deployment, and remove the old key only
  after that deployment has succeeded.

### Local-user / stdio password

`ZM_EMAIL`/`ZM_PASSWORD` is used by the stdio MCP entrypoint, smoke tools,
and local-user provisioning. The HTTP MCP server, watcher, and hooks
authenticate through OAuth and do not consume these credentials. After
changing the account password, update only the environments that run those
local/stdio paths; the current production compose template still passes the
pair to `zm-server` for compatibility with that entrypoint.

Changing it is an Auth operation, not a deployment one: use the platform's
admin API or console. The provisioning step will **not** do it — that path is
create-only and skips an account that already exists.

It is still an account password, so the rule above applies to it too: changing
it revokes every other session that account holds. Nothing on the server signs
in as it over OAuth, so in practice this is invisible — unless a person has
also been signing in as the service account, in which case their clients need
re-authorizing like any other.

Dev checkouts use root `.env` + `apps/server/.env`; `seed-env` only
force-syncs the throwaway `dev@zero-memory.local` account, never a custom
one.

**The `$` gotcha:** Bun expands `$VAR`/`${VAR}` inside `.env` values, and
single quotes do **not** prevent it — a password like `abc$Def` silently
loads as `abc`. Escape it as `abc\$Def`, or avoid `$` in passwords
entirely. When verifying, never print the password — compare length or a
masked form.

## Migrations at deploy

With `ZM_MIGRATE_ON_DEPLOY=1` in `infra/prod/.env`, `upgrade.sh` manages the
schema itself, in this order and before any container changes:

1. reads `SUPABASE_DB_URL` from `ZM_DB_ENV_FILE` (default
   `/etc/zero-memory/backup.env` — the same file the backup timer reads, so
   the credential has exactly one home on the host);
2. asks `db-forward-apply.sh pending` whether anything is pending — the probe
   runs the applier's full checks, so a diverged series aborts the deploy
   right here;
3. when something is pending, takes a pre-schema dump via `db-dump.sh` into
   `/var/backups/zero-memory/pre-deploy` (keep 5) with the off-site mirror
   and the dead-man pings explicitly muted — a deploy dump must never
   masquerade as the daily backup;
4. applies the pending tail strictly forward, each file in one transaction
   together with its `supabase_migrations.schema_migrations` bookkeeping row,
   and verifies the watermark equals the end of the checked-out series.

Any failure aborts the deploy while the previous containers still serve; the
schema that did land stays (forward-only, additive — the running code does
not notice it). `db-provision.sh` from an operator machine remains the
first-time provisioning path and the manual fallback.

The applier's vehicle is the dockerized psql client the backups already use,
so the first flagged deploy on a fresh host pulls that ~1 GB image once —
the same one-time cost the first backup pays. A host that never sets the
flag deploys exactly as before.

## Rollback

A release that turns out bad is undone by **re-pinning the image tag**, not by
rebuilding anything and never by touching the database:

```sh
infra/prod/scripts/upgrade.sh <previous-tag>     # on the host
infra/prod/scripts/verify-instance.sh <server-url> <web-url>
```

The tag argument is what makes this safe to walk away from: `upgrade.sh`
persists the pin into `infra/prod/.env` before deploying, so the next bare run
redeploys the rolled-back version instead of silently rolling forward again.
`up -d --wait` holds until the containers are healthy, and `verify-instance.sh`
prints the build it actually reached — read that line rather than the exit code
of the deploy.

Which tag to go back to: the mirror clone's own tags are the authority for what
has been released — `git -C <mirror> tag --sort=-v:refname | head`.

Rehearsed rather than assumed, on a scratch stand: rolling one release back
took **37 s** and the same trip forward **21 s**, the older release passed the
full external acceptance against the current schema, and a subsequent bare
`upgrade.sh` with no argument stayed on the rolled-back version instead of
quietly returning to the newest one. That last check is the point of persisting
the pin, and it is the one worth repeating if the script ever changes.

**The database does not roll back with the code.** Migrations are forward-only
and the schema is ADD-only, so an older server against a newer schema is the
designed case, not an accident. Two consequences worth knowing before you need
them:

- if the bad release carried **no** migrations, the rollback is a pure image
  change and nothing else has to happen;
- if it carried migrations, still do not reverse them. Restoring a backup is a
  different operation with a different goal (recovery of lost data, above),
  and using it to undo a code defect throws away everything written since.

What a rollback does **not** undo: memories the bad build wrote. The store is
ADD-only on the agent path, so those rows stay and are removed, if at all,
through the ordinary supersede/forget operations.

## Incident quick checks

1. **Server up?** `GET /healthz` — no answer means the process/container is
   down: `docker compose --project-directory infra/prod ps`,
   `docker logs zero-memory-zm-server-1 --tail 100`.
2. **Downstream up?** `GET /readyz` — `supabase: false` means the database's
   API gateway is unreachable. Where to look next depends on who runs it: with
   a **managed project** there is nothing of ours to inspect, so check the
   provider's status page and the project's dashboard before touching
   zm-server; with a **stack on this host**, check its containers first.
3. **Ingest received but never processed** (extractor failing — bad
   `ANTHROPIC_API_KEY`, provider outage) — as the service role:

   ```sql
   select count(*) as stuck, min(received_at) as oldest
   from public.ingest_log
   where processed_at is null
     and received_at < now() - interval '15 minutes';
   ```

   A growing `stuck` count with fresh `received_at` = ingestion works,
   extraction does not; check server logs for extractor errors. Note:
   chunks are logged by hash, so a chunk that failed extraction is **not**
   retried automatically — the watcher's job ends at delivery.

4. **Watcher behavior when the server is down:** it never crashes — failed
   sends stay in its in-memory retry queue and per-file byte offsets are
   persisted (`$XDG_STATE_HOME/zero-memory/watcher.json`), so a watcher
   restart resumes where it left off instead of re-ingesting. After a long
   server outage expect a catch-up burst of ingest traffic.
5. **Mail flows (dev/stage):** the CLI stack's local mail catcher
   (`supabase status` prints its URL) shows confirmation and
   password-recovery mails that never reach a real inbox.
6. **Mail not arriving** (a user cannot register, or recovery never lands).
   Nothing in our own logs will show this — mail leaves from the database's Auth
   service, not from zm-server — so check in this order, cheapest first:

   1. **Provider dashboard.** Was the message accepted, bounced, or refused for
      a limit? A suspended or unverified sender domain shows up here and nowhere
      else. Check the sending domain's SPF/DKIM/DMARC still verify — a DNS edit
      elsewhere in the zone can break them.
   2. **Did Auth try at all?** SMTP refusals and template-fetch failures are
      logged by the Auth service — in the provider's log explorer for a managed
      project, or `docker logs <auth-container> --tail 200` for a stack you run.
      Auth also rate-limits per address (`GOTRUE_SMTP_MAX_FREQUENCY`, default
      1m) — a user hammering "resend" gets silence by design.
   3. **Arrived but the link is wrong** (wrong host, or straight to the
      dashboard root instead of the flow): the redirect allow-list. An origin
      absent from `ADDITIONAL_REDIRECT_URLS` is replaced by `SITE_URL`
      **silently**. Both must be the external dashboard URL.
   4. **Arrived but looks like Supabase's default template:** Auth could not
      fetch ours — which only applies to a stack you run yourself. A managed
      project cannot fetch templates at all: they are pasted into its Auth
      settings, so there the answer is that the paste is stale or missing.
      Self-hosted, Auth fetches over HTTP, so from inside the auth container the
      URL must answer:
      `docker exec <auth-container> wget -qO- "$GOTRUE_SITE_URL/email-templates/recovery.en.html" | head -c 200`.
      Empty or 404 = the dashboard is not serving the export (is
      `apps/web/public/` in the image?) or the overlay is not applied. A fetched
      template is cached for `GOTRUE_MAILER_TEMPLATE_MAX_AGE` (default 10m), so
      a fix is not visible immediately.
   5. **Landed in spam.** Almost always the sender domain rather than the
      content: verify SPF/DKIM/DMARC, and that the From address is on the
      verified domain (`SMTP_ADMIN_EMAIL`).

## Security posture

What is enforced, and where:

- **RLS is the data boundary.** Every MCP/web request runs under the caller's
  Supabase JWT; Postgres row-level security decides what each user can see or
  write (scope membership via `scope_members`, private-by-default). The
  server never widens access on a user path.
- **OAuth surface is rate-limited.** `POST /oauth/token`, `POST
/oauth/authorize`, `POST /oauth/register` — the only unauthenticated,
  brute-forceable endpoints — share an in-memory fixed-window limiter keyed
  by client IP + route (`ZM_RATELIMIT_MAX` per `ZM_RATELIMIT_WINDOW_S`,
  default 30/60 s; over-limit → 429 + `Retry-After`). Client IP is the first
  `X-Forwarded-For` hop — only trustworthy behind our caddy/nginx edge, with
  the socket address as fallback.
- **OAuth tables are deny-all.** `oauth_clients` / `oauth_codes` have RLS
  enabled with **no** policies; only the service-role adapter behind the
  OAuth endpoints reaches them.
- **Authorization codes are single-use and short-lived.** Redemption is an
  atomic `DELETE … RETURNING` (a replayed or raced code loses), TTL 5
  minutes, expired codes swept opportunistically.
- **PKCE S256 is mandatory** (plain rejected), redirect URIs are exact-match
  against registration, and registration accepts only https or loopback-http
  URIs. Login failures render one constant message (no user-exists oracle);
  credentials are never logged.
- **Memories are ADD-only** on the agent path: `remember`/`ingest` append;
  supersede/forget are explicit, provenance-tracked operations.
- **Bounded server state.** MCP sessions are capped (`ZM_MAX_SESSIONS`,
  default 200; LRU eviction closes the transport) on top of the 30-minute
  idle TTL.
- **Headers.** OAuth HTML pages and all web responses send
  `X-Content-Type-Options: nosniff`, a `Referrer-Policy`, and CSP
  `frame-ancestors 'none'`; OAuth responses are `Cache-Control: no-store`.

Residual risks and deferred items (honest list):

- **No per-user write limits** — a valid account can write unbounded memories;
  the rate limiter only covers the unauthenticated OAuth surface.
- **Rate limiting is per-process, in-memory** — resets on restart, not
  shared across replicas; fine for the single-instance topology, revisit if
  that changes.
- **No audit-log UI** — provenance is stored per memory, but there is no
  reviewable audit trail of auth/administrative events.
- **Secrets live in `.env` files** — no secret-manager integration;
  rotation is the manual procedure above ("Key & secret rotation").
- **Refresh tokens are Supabase's** — revocation is per-session via
  Supabase Auth; there is no client-facing token-revocation endpoint (RFC 7009) yet.
- **Advisor residue (accepted):** `public.create_scope` is an intentionally
  authenticated-callable `security definer` RPC (bootstraps scope creation
  past the admin-only RLS insert; validates roots, pins `search_path`);
  unused-index INFOs reflect a young stack, revisit with real traffic.

## Monitoring

What to poll — plain HTTP/exec probes, plus the counters the server already
exposes:

| Probe                                                                          | Suggested alert                                   |
| ------------------------------------------------------------------------------ | ------------------------------------------------- |
| `GET /healthz` (server), `GET /` (web)                                         | 3 consecutive failures over 90 s                  |
| `GET /readyz`                                                                  | `ok: false` for > 5 min (tolerate stack restarts) |
| `docker ps` health status of zm-server, zm-web                                 | any container `unhealthy`                         |
| the backup job's dead-man ping (`ZM_DUMP_PING_URL`)                            | no ping for > 26 h                                |
| `systemctl is-active zm-dump.timer` / `zm-snapshot.timer`, newest artifact age | newest backup older than 26 h                     |
| stuck-ingest SQL above                                                         | `stuck > 0` for > 1 h                             |
| disk of the backup directory and docker volumes                                | > 85 % used                                       |

### `GET /metrics`

A Prometheus scrape target in the text exposition format, served by the same
process — in-process counters, no exporter and no extra infrastructure.
Counters are monotonic **for the process lifetime**, so a restart resets them
to zero: alert on rates and increases (`rate()`, `increase()`), never on
absolute values.

| Counter                                | Labels   | What a rise means                                                                                                                                    |
| -------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http_requests_total`                  | `status` | Baseline traffic; a shift in the status mix is the signal, not the total                                                                             |
| `http_errors_total`                    | —        | Unhandled errors — any sustained non-zero rate deserves a look at the logs                                                                           |
| `mcp_tool_calls_total`                 | `tool`   | Which tools sessions actually use; a flat line during working hours means clients are not reaching the server                                        |
| `promoted_rules_lookup_failures_total` | —        | Sessions that silently fell back to base instructions — owners are losing their network-served rules, invisibly to the client. Alert on any increase |

The endpoint is unauthenticated and carries no user data (counts and tool
names only), but the edge proxies every path on the MCP hostname — so both
shipped edge configs answer `404` for `/metrics` on purpose. Scrape it from
inside instead (`http://zm-server:8787/metrics` from the compose network,
`http://127.0.0.1:8787/metrics` on the host); if your scraper is external,
remove that block and put your own protection in front of it.

Deferred: probe latencies and ingest/extraction histograms — counters cover
the current scale.
