# @workspace/endpoint-guard

Guards a server-side `fetch` against SSRF through a user-supplied endpoint —
today, Ollama's `base_url`, consumed by `packages/llm`'s ollama branch. With
no host check a user can point the server at `http://169.254.169.254/...` or
`http://localhost:PORT` and have it fetched from the server itself.

The one consumer is `packages/llm`, which runs under Bun. The dashboard
deliberately does **not** import this package: a check at credential-save
time is not the boundary anyway (the address can resolve differently by the
time the credential is used), and the import cost a working dashboard once —
workspace packages here ship raw TypeScript with `.js`-suffixed re-exports,
which Turbopack resolves to an empty module unless the package is listed in
`transpilePackages`, taking every page down with it.

## What it checks

`resolvePublicAddress(host)` resolves a hostname (or accepts an address
literal, bracketed or not) and rejects it with `PrivateEndpointError` if it
— or, for a name with several records, _any_ of its resolved addresses —
falls in:

- IPv4 loopback, `0.0.0.0/8`, and RFC1918 private space
- IPv4 link-local (`169.254.0.0/16`, where cloud metadata endpoints live)
- carrier-grade NAT (`100.64.0.0/10`) and benchmarking (`198.18.0.0/15`) —
  not private space in the RFC1918 sense, but on a shared server they
  address the operator's own overlay network and pod space
- IPv6 loopback, unique-local (`fc00::/7`), and link-local (`fe80::/10`)
- an IPv6 address embedding any of the above, in all four spellings:
  IPv4-mapped (`::ffff:127.0.0.1`), IPv4-compatible (`::7f00:1`),
  IPv4-translated (`::ffff:0:7f00:1`) and NAT64 (`64:ff9b::7f00:1`)

Of the surviving records an IPv4 one is preferred. All of them are already
checked, so that choice is about reachability, not safety: `verbatim` order
often puts AAAA first on Linux, and pinning to it would strand a dual-stack
host on an IPv4-only Docker network.

## Deployment-mode policy

Denying is **off by default** — the self-host default, since a self-hoster
legitimately points Ollama at `127.0.0.1` and a blanket deny would break
that:

```sh
ZM_POLICY_DENY_PRIVATE_ENDPOINTS=true   # shared-server deployments only
```

Unset or unparseable reads as `false`, matching every other `ZM_POLICY_*`
value's fail-open convention. A deployment that sets it must also pass it
into the container — `infra/prod/docker-compose.yml` names it explicitly,
since those services take no `env_file`.

## Fetch-time enforcement

`createGuardedFetch({ denyPrivateEndpoints })` returns a `fetch` a provider
client uses directly (as `@ai-sdk/openai-compatible`'s `fetch` option). It
re-checks on every call, and closes the two ways a checked address stops
being the address actually visited:

- **Redirects are refused.** `fetch` follows a cross-host redirect itself,
  inside one call, so an approved endpoint answering
  `307 Location: http://169.254.169.254/…` would reach the metadata service
  with the guard none the wiser. `redirect: 'manual'` surfaces the 3xx and it
  becomes a `RedirectRefusedError` — a redirect is not part of any legitimate
  completions exchange, so it is an error rather than a hop.
- **Plain HTTP is pinned** to the exact address just checked, instead of
  letting the runtime resolve the name a second time — the disagreement
  between those two lookups is what DNS rebinding relies on.

HTTPS is checked but not pinned: pinning would send the raw IP as the TLS
server name, which a real certificate for a named host does not cover.

With no configuration `createGuardedFetch` returns plain `fetch` — no
interception, no DNS lookup, no redirect policy, no behaviour change from
before this package existed.
