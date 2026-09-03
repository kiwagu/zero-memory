# @workspace/llm

The one way this server talks to a language model.

Before this package there were nine of them: the extractor, the usefulness
judge, the hygiene judge, the kind auditor, two distillers, the loop-closure
judge, the ROI judge and prober, and the translator each built their own client
and made their own call. Nine copies of the same lazy-client dance, and — more
to the point — no single place where the spend they cause could be observed or
held back.

## The port

`ILlmGateway.callTool` covers almost every call, because they share one shape:
a system policy, one user turn, and a single tool the model is forced to
answer through.

```ts
const answer = await gateway.callTool({
  model,
  maxOutputTokens: 1024,
  system: JUDGE_POLICY,
  prompt,
  tool: { name: 'record_verdict', description: '…', inputSchema },
  purpose: 'hygiene_judge',
});
```

The gateway extracts the tool call and raises if the model answered without
one — a check every caller used to repeat. It returns the raw tool input
unvalidated: callers parse against their own schema, and several parse
leniently so one bad sub-item does not discard an otherwise good answer.

`purpose` is recorded with the call's token counts and is the only thing a
decorator needs in order to tell which allowance a call falls under. Its values
match what has been written to the usage ledger since the first metered run —
changing one severs that series.

### Asking with the live web

`searchWeb` is the second method, and it exists because the structured call
cannot carry tools: `generateObject` takes a schema, not a tool list. It runs
`generateText` with Anthropic's server-side `web_search` tool — declared
alone, since that tool brings its own execution environment and a second one
only confuses the model — and returns the answer with its cited sources.

```ts
const research = await gateway.searchWeb({
  model,
  maxOutputTokens: 2048,
  system: SEARCH_POLICY,
  prompt,
  purpose: 'reverification',
  maxSearches: 5,
});
```

Two honesty properties callers depend on. Server-side web search is a property
of the ANTHROPIC API, not of a model or of whose key pays: a call resolved to
any other vendor raises `WebSearchUnavailableError` rather than answering from
training data, so a caller can skip the work and SAY it skipped instead of
recording a check that never happened. And `exhausted` is set whenever
generation ended without a clean stop — the output cap, or the server-tool
loop running out of budget (the API's `pause_turn`, which SDK runners do not
auto-resume) — marking the text partial so no verdict is drawn from it.

## Getting hold of it

Two ways, because there are two kinds of caller:

- **Injected** — `@injectLlmGateway()` for anything the container builds.
- **`llmGateway()`** — for background jobs (the hygiene scanner, the ROI
  runner, the translation worker), which construct their collaborators
  themselves and have no injection point to receive one through.

Call `llmGateway()` at the point of use rather than caching it in a field: a
class built before the composition root ran would otherwise hold the
undecorated gateway for the rest of the process's life.

## Speaking a vendor

One adapter, `AiSdkProvider`, says every call in the [Vercel AI
SDK](https://ai-sdk.dev)'s dialect. The forced tool call becomes a
`generateObject` whose output schema _is_ the tool — the tool's name and
description carry through unchanged, so the model is still told exactly what to
produce. What used to differ between vendors — a tool versus a function, a
parsed object versus a JSON string, differently named token counters — the SDK
now normalises, so there is no hand-written per-vendor adapter left to keep.

All the per-vendor knowledge that remains lives in `model-factory.ts`: a closed
map from `ProviderName` to the SDK provider that builds its model, each with the
default model it falls back to. Six vendors are wired — Anthropic, OpenAI, xAI
(Grok), DeepSeek, Moonshot (Kimi, over its OpenAI-compatible endpoint) and
Ollama — and adding another is one entry here plus the same name in the database
check and the `PROVIDER_NAMES` set in `credential.ts`. The map is closed because
the union is — the database enforces the same set — which is what keeps "run on
your own key" from becoming "point the server at an arbitrary endpoint".

Every vendor but one reaches an endpoint of its own. Ollama does not: it runs
wherever the user installed it, so its endpoint travels on the credential as
`baseURL` and the factory refuses it when absent rather than guessing a host.
That URL is the one caller-supplied endpoint, so it is fenced accordingly — the
database permits `base_url` for Ollama alone and only as http(s), and Ollama is
keyless (a local server ignores the bearer token). Host-level egress control
belongs to a managed, multi-tenant deployment; here, where a tenant is a single
instance, the user supplying the URL is the operator of the box it points at.

Token counts are read as the vendor's totals. While prompt caching is off — the
extraction prefix sits at the cache minimum and is never cached — the input
total equals the base count the metered series has always recorded; turning
caching on later would fold cache-read tokens into that figure and has to be
reconciled then.

The factory is a constructor seam: a test hands `AiSdkProvider` a factory that
returns a mock model, driving the real adapter with no key and no network.

Which model a call actually asks for is `effectiveModel`: a model carried on
the CREDENTIAL wins, because a stored BYOK row names the model its owner
chose, and on any vendor but Anthropic the model names in the code do not
apply anyway. The platform credential therefore carries NO model of its own —
it backs every purpose at once, so a model pinned there would silently
override the judges and the web-search call alike. Call sites that want an env
override (the extractor, the ROI judge and prober) read it themselves and pass
it as the call's own model.

## Guarding it

`GuardedLlmGateway` wraps any gateway with a budget check from
[`@workspace/policy`](../policy/README.md), in the shape the audit decorator on
the command bus already established. It is installed once, in the server's
composition root, which both registers it in the container and installs it
process-wide — so neither kind of caller can route around it.

A decorator rather than a proxy in front of the network: there is exactly one
port to wrap, so a separate hop would buy nothing and could be bypassed by
anything holding a client of its own. If this server ever grows more processes
that generate, this class is what moves out into a gateway of its own, and the
interface it implements would not change.

The check happens _before_ the call, so an exhausted budget cannot spend one
more call proving it is exhausted. When there is nothing left the wrapper
raises `BudgetExhaustedError` and the model is never reached — deliberately
not a quiet empty answer, which downstream would read as "nothing worth
extracting" and record the work as done.

With nothing configured the guard resolves to unlimited and the wrapper is a
pass-through. That is the state every self-hosted deployment runs in.
