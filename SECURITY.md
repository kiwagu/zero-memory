# Security policy

zero-memory stores what its users decide to remember: decisions, working
notes, and the reasoning behind them, scoped to people and teams by database
row-level security. A defect that widens what one account can read is a data
breach for everyone on that instance, so security reports get priority over
everything else in the queue.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through this repository's **Security** tab —
_Report a vulnerability_. That opens a thread only the maintainers can read,
lets us discuss details safely, and turns into a published advisory once a
fix is out.

A useful report contains:

- what an attacker can do, stated as an outcome (read another account's
  memories, escalate to service-role, execute code on the server host);
- the steps to reproduce it, ideally against a local stack brought up from
  this repository;
- the version or commit you tested, and how the instance was deployed
  (self-hosted compose stack, Supabase cloud, development stack);
- anything you already know about the fix — welcome, never required.

## What to expect

This is a small project, so the honest commitments are modest ones:

- **Acknowledgement within five business days.** If you hear nothing by then,
  assume the report did not arrive and send it again.
- **An assessment with a severity and a plan** once the issue is reproduced.
- **A fix released before the advisory is published**, and credit in that
  advisory unless you ask to stay anonymous.
- **Coordinated disclosure.** We ask that you give us a reasonable window to
  ship a fix before publishing. We will not ask you to stay silent
  indefinitely, and we will not pursue anyone who reports in good faith and
  stays within the scope below.

There is no bug-bounty programme and no payment.

## Supported versions

Fixes land on the latest release. Older tags are not patched — an instance is
expected to upgrade rather than to receive a backport.

## Scope

**In scope** — anything shipped from this repository: the MCP server, the
dashboard, the client adapters and the watcher binary, database migrations
and row-level-security policies, the production compose stack and its edge
configuration, and the defaults each of them ships with. Cross-scope memory
disclosure, authentication and OAuth flaws, token or session handling, and
server-side request forgery from operator-supplied endpoints are all squarely
in scope.

**Out of scope** — vulnerabilities in Supabase, Postgres, Docker, model
providers, or other upstream software (report those upstream; tell us too if
our defaults make them worse); findings that require an already-compromised
host, a stolen service-role key, or physical access; resource exhaustion of a
self-hosted instance by its own operator; and reports produced only by an
automated scanner with no demonstrated impact.

## For operators

Two properties of a deployment carry most of the risk and are worth checking
before you expose an instance:

- `ZM_PUBLIC_URL` must equal the external URL of the MCP server — it is the
  OAuth issuer embedded in every challenge.
- The service-role key must never reach a browser, a client machine, or a
  log. Only the server and the migration tooling need it.

The deployment guide in [`docs/getting-started/deployment.mdx`](./docs/getting-started/deployment.mdx)
and the operations runbook in [`infra/prod/RUNBOOK.md`](./infra/prod/RUNBOOK.md)
cover backups, key rotation, and incident checks.
