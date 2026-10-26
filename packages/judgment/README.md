# @workspace/judgment

Typed judgments for the memory server: a few yes/no questions over one piece
of state, answered with probabilities by a decision model. Code owns the
workflow; the model supplies one number per question and generates no text.

- `IJudgment` — the port (`judge(request, { timeoutMs })`).
- `TypeSafeJudgment` — TypeSafe System One (`POST /v1/systemone`, Noul questions).
- `SubqJudgment` — SubQ Snap (see "Providers").
- `readJudgeConfig(env)` / `readRuleGateConfig(env)` — the server's env knobs.
- `@workspace/judgment/testing` — `FakeJudgment` for unit and e2e tests.

## Env

| Variable                  | Default      | Meaning                                          |
| ------------------------- | ------------ | ------------------------------------------------ |
| `ZM_JUDGE_PROVIDER`       | `typesafe`   | platform default provider (`typesafe` or `subq`) |
| `ZM_TYPESAFE_API_KEY`     | —            | platform TypeSafe key                            |
| `SNAPQ_API_KEY`           | —            | platform SubQ key                                |
| `ZM_JUDGE_MODEL_TYPESAFE` | `jev-1.14.0` | pinned TypeSafe model                            |
| `ZM_JUDGE_MODEL_SUBQ`     | `snap-1.1`   | SubQ model id                                    |
| `ZM_JUDGE_TIMEOUT_MS`     | `1500`       | per-request timeout                              |

A provider with no key is simply not configured: callers see "judge not
configured" and work as before. There is no fallback to another provider.
