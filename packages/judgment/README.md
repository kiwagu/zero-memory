# @workspace/judgment

Typed judgments for the memory server: a few yes/no questions over one piece
of state, answered with probabilities by a decision model. Code owns the
workflow; the model supplies one number per question and generates no text.

- `IJudgment` — the port (`judge(request, { timeoutMs })`).
- `TypeSafeJudgment` — TypeSafe System One (`POST /v1/systemone`, Noul questions).
- `SubqJudgment` — SubQ Snap (see "Providers").
- `IJudgeCredentialResolver` — whose key a call runs on; `EnvJudgeCredentialResolver`
  serves the platform keys from the env, and a provider without one resolves to null.
- `IJudgeSettingsReader` — an account's rule-gate choice (`enabled`, `provider`, null = the
  platform default); `JUDGE_SETTINGS_OFF` when the account has made none.
- `defaultJudgmentFactory` — builds the adapter a resolved credential names; the server binds
  it (or the fake) to `JUDGMENT_FACTORY`.
- `readJudgeConfig(env)` / `readRuleGateConfig(env)` — the server's env knobs.
- `@workspace/judgment/testing` — `FakeJudgment` for unit and e2e tests.
- `@workspace/judgment/availability` — `SUBQ_ADAPTER_AVAILABLE`, importable without
  the DI container (no decorator metadata), for UI code that offers the provider choice.

## Env

| Variable                  | Default         | Meaning                                                                                               |
| ------------------------- | --------------- | ----------------------------------------------------------------------------------------------------- |
| `ZM_JUDGE_PROVIDER`       | `typesafe`      | platform default provider (`typesafe` or `subq`)                                                      |
| `ZM_TYPESAFE_API_KEY`     | —               | platform TypeSafe key                                                                                 |
| `ZM_SNAPQ_API_KEY`        | —               | platform SubQ key                                                                                     |
| `ZM_JUDGE_MODEL_TYPESAFE` | `jev-1.14.0`    | pinned TypeSafe model                                                                                 |
| `ZM_JUDGE_MODEL_SUBQ`     | `subq-snap-1.1` | SubQ model id                                                                                         |
| `ZM_JUDGE_TIMEOUT_MS`     | `1500`          | per-request timeout                                                                                   |
| `ZM_JUDGE_FAKE`           | —               | tests only: `1` binds a deterministic judge and a dummy platform credential; never on a serving stack |

A provider with no key is simply not configured: callers see "judge not
configured" and work as before. There is no fallback to another provider.

## Rule gate

The rule gate (`RuleGateService` in `@workspace/memory`) is this package's
first caller: per briefing, one yes/no question per unpinned standing rule,
mapped to a delivery level by two bands. `readRuleGateConfig(env)` reads its
knobs; the server calls it once at startup, so a malformed value stops the
server instead of failing every briefing.

| Variable            | Default | Meaning                                                                                                                             |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ZM_RULE_GATE_MODE` | `off`   | `off` judges nothing; `shadow` judges and records the levels in `rule_gate` but delivers every rule whole; `live` delivers by level |
| `ZM_RULE_GATE_HI`   | `0.60`  | `p >= HI` → `full`                                                                                                                  |
| `ZM_RULE_GATE_LO`   | `0.35`  | `LO <= p < HI` → `gate` (headline + `applies_when`); `p < LO` → `headline`                                                          |

Both bands lie strictly between 0 and 1, and `LO` must be below `HI`. The
gate's per-call timeout is `ZM_JUDGE_TIMEOUT_MS`. An account is judged only
when it turned the judge on (`IJudgeSettingsReader`) and a credential
resolves for it; the settings are read first, so an account with the judge
off costs no key lookup. Pinned rules are never judged.

The gate fails open. Once a call is set to be judged, anything that keeps
the answer from coming back delivers the call's rules exactly as without the
gate, with `rule_gate.judge_unavailable: true` and, when the reason is known,
`rule_gate.unavailable_reason`:

- `settings_unavailable` — the account's judge settings could not be read
  (`JudgeSettingsUnavailableError`); a read that finds no row is "off", not a
  failure;
- `credential_unavailable` — whether the account holds its own key could not
  be established (`JudgeCredentialUnavailableError`). Only a lookup that
  succeeded and found no key falls back to the instance's key;
- `budget_unavailable` / `budget_exhausted` — the account's extraction
  allowance on the instance's key could not be read, or is used up;
- `judge_error` — the judge call failed other than by not answering
  (`JudgeRequestError`, a malformed response).

A timeout, a `429` or a `5xx` (`JudgeUnavailableError`) carries no reason. A
rule the answer leaves out is delivered whole. No other provider is tried.

Switching it on, shadow first:

1. Set `ZM_RULE_GATE_MODE=shadow` in the serving environment and restart.
   Delivery does not change; each judged call records what it would have
   delivered in its `mcp_tool_call` row, and the daily series fill.
2. Leave it for two to three weeks of normal use. Read the series
   (`rule_gate_calls`, `rules_chars_baseline` against `rules_chars_delivered`,
   `judge_unavailable`, `judge_latency_ms_sum`), the per-rule numbers on
   `/rules`, and the judge's agreement with an LLM
   (`bun run rules:gate-agreement` in `apps/server`, on a stand holding a
   clone of the serving data).
3. Rewrite the `applies_when` lines of rules that are often fetched after a
   headline, on `/rules`. For rules that have none, `rules:applies-when-draft`
   in `apps/server` (a service-role script, run against a stand) drafts and
   stores one each, which the owner reviews and edits on `/rules`. Move the
   bands only if the probes say so: draft them with
   `scripts/rule-probes-draft.ts`, confirm them by hand and import them, then
   replay them with `scripts/rule-gate-eval.ts`.
4. Set `ZM_RULE_GATE_MODE=live` and restart. Going back is the same switch:
   `shadow` or `off` delivers every rule whole again.

## Providers

Both providers speak the same System One wire shape, so both adapters are thin
wrappers over one exchange (`system-one.exchange.ts`); they differ only in host
and model ids. The exchange keeps only the answers to the questions it asked,
maps `noul` (already 0..1) to `{ noul }`, and reports `model` and `usage` from
the response, or the configured model and zeros when the response carries
none.

One status policy for both providers:

- `429` and any `5xx` → `JudgeUnavailableError` (no verdict; try later);
- no complete answer within the timeout, body read included →
  `JudgeUnavailableError`;
- any other non-2xx → `JudgeRequestError`, `<provider>: HTTP <status>: <body>`
  with the body cut to 200 characters and the `status` on its own (the
  request is wrong; a retry won't help). The rule gate logs the status only,
  never the body;
- a 2xx body that does not match the shape (not JSON, a `noul` outside 0..1)
  → a plain `Error`, never `JudgeUnavailableError`.

### TypeSafe

- Endpoint: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`.
- Model: `jev-1.14.0` by default (`ZM_JUDGE_MODEL_TYPESAFE`); the response may
  name a different `model` than the alias sent, and the adapter reports the
  one the response names.
- Request: `{ model, state, questions: { <name>: { type: 'noul', instructions, criteria } } }`,
  where `criteria` is `{ true, false }`. Instructions point into `state` by
  a dotted path in backticks, so a key that holds a dot does not resolve:
  the rule gate names each rule by position (`r1`, `r2`, …) as its question
  and as its key under `state.rules`, and maps the answers back to rule ids
  itself.
- Response: `{ model, answers: { <name>: { type: 'noul', noul } }, usage: { input_tokens, output_tokens } }`.
- Statuses: TypeSafe documents `429` and `529` as retryable; both fall under
  the shared policy above.

### SubQ Snap

The SubQ Decisions API (public preview), documented at
`https://docs.subq.ai/llms.txt` → "Decisions API".

- Endpoint: `POST https://api.subq.ai/v1/systemone`, `Authorization: Bearer <key>`.
- Model: `subq-snap-1.1` by default (`ZM_JUDGE_MODEL_SUBQ`). `GET /v1/models`
  lists the ids a key may use; `subq-snap-preview` is the other decision model.
- Request: the same shape as TypeSafe:

  ```json
  {
    "model": "subq-snap-1.1",
    "state": { "task": "squash the branch and release" },
    "questions": {
      "r1": {
        "type": "noul",
        "instructions": "Does the rule bind the task in `task`?",
        "criteria": {
          "true": "the task will commit",
          "false": "the task touches no git history"
        }
      }
    }
  }
  ```

- Response:

  ```json
  {
    "model": "subq-snap-1.1",
    "answers": { "r1": { "type": "noul", "noul": 0.92 } },
    "usage": { "input_tokens": 477, "output_tokens": 0 }
  }
  ```

  SubQ bills input tokens only; `output_tokens` is always `0`.

- Errors carry `{ detail: { error_type, message } }`. Under the shared policy,
  `429` (rate limit) and `5xx` (`503`: temporarily unavailable) →
  `JudgeUnavailableError`; `400` (over the token limit), `401`, `402` (no
  credits), `403` (the key may not use the model) and `422` (invalid request)
  → `Error` with the status.
