# @workspace/judgment

Typed judgments for the memory server: a few yes/no questions over one piece
of state, answered with probabilities by a decision model. Code owns the
workflow; the model supplies one number per question and generates no text.

- `IJudgment` — the port (`judge(request, { timeoutMs })`).
- `TypeSafeJudgment` — TypeSafe System One (`POST /v1/systemone`, Noul questions).
- `SubqJudgment` — SubQ Snap (see "Providers").
- `IJudgeCredentialResolver` — whose key a call runs on; `EnvJudgeCredentialResolver`
  serves the platform keys from the env, and a provider without one resolves to null.
- `defaultJudgmentFactory` — builds the adapter a resolved credential names.
- `readJudgeConfig(env)` / `readRuleGateConfig(env)` — the server's env knobs.
- `@workspace/judgment/testing` — `FakeJudgment` for unit and e2e tests.
- `@workspace/judgment/availability` — `SUBQ_ADAPTER_AVAILABLE`, importable without
  the DI container (no decorator metadata), for UI code that offers the provider choice.

## Env

| Variable                  | Default         | Meaning                                          |
| ------------------------- | --------------- | ------------------------------------------------ |
| `ZM_JUDGE_PROVIDER`       | `typesafe`      | platform default provider (`typesafe` or `subq`) |
| `ZM_TYPESAFE_API_KEY`     | —               | platform TypeSafe key                            |
| `SNAPQ_API_KEY`           | —               | platform SubQ key                                |
| `ZM_JUDGE_MODEL_TYPESAFE` | `jev-1.14.0`    | pinned TypeSafe model                            |
| `ZM_JUDGE_MODEL_SUBQ`     | `subq-snap-1.1` | SubQ model id                                    |
| `ZM_JUDGE_TIMEOUT_MS`     | `1500`          | per-request timeout                              |

A provider with no key is simply not configured: callers see "judge not
configured" and work as before. There is no fallback to another provider.

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
- any other non-2xx → a plain `Error`, `<provider>: HTTP <status>: <body>`
  with the body cut to 200 characters (the request is wrong; a retry won't
  help);
- a 2xx body that does not match the shape (not JSON, a `noul` outside 0..1)
  → a plain `Error`, never `JudgeUnavailableError`.

### TypeSafe

- Endpoint: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`.
- Model: `jev-1.14.0` by default (`ZM_JUDGE_MODEL_TYPESAFE`); the response may
  name a different `model` than the alias sent, and the adapter reports the
  one the response names.
- Request: `{ model, state, questions: { <name>: { type: 'noul', instructions, criteria } } }`,
  where `criteria` is `{ true, false }`.
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
