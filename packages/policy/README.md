# @workspace/policy

A neutral budget engine for the operations that cost real money per call — the
LLM ones. It answers a single question: _may this metered operation run right
now?_

Nothing here knows what an operation is worth or why a ceiling exists. It only
knows named budgets, their limits, and how much has been spent.

## What can be budgeted

`BUDGETS` in [`src/budget.ts`](./src/budget.ts) is the complete, enumerable
registry. An operation that is not listed there can never be limited, because
the guard has no name to look up.

| Budget        | Counted against | Covers                              |
| ------------- | --------------- | ----------------------------------- |
| `extraction`  | the user        | turning conversations into memories |
| `maintenance` | the instance    | background upkeep nobody requested  |
| `translation` | the user        | canonicalising memory text          |

Storage, recall, briefings, and export are deliberately absent and always will
be: reading your own data must never depend on an allowance.

`maintenance` is instance-wide rather than per-user because the usage ledger
records background work with no user id — a per-user allowance physically
cannot see it, so it gets its own ceiling instead of being silently unbounded.

## How a limit is resolved

Unlimited is the built-in default, and each source may override it. The last
one to speak wins:

```
built-in unlimited  →  ZM_POLICY_* environment  →  stored per-user row
```

That order makes the quiet case the safe one. A deployment that configures
nothing runs with no ceilings at all, which is the intended resting state: a
budget exists only because someone chose to set one. A source that says
nothing leaves whatever was already resolved in force, so a missing value can
never tighten anything.

### Configuring an instance

Two variables per budget, both optional:

```sh
ZM_POLICY_EXTRACTION_LIMIT=2000000       # tokens
ZM_POLICY_EXTRACTION_WINDOW_DAYS=30      # defaults to the budget's own window
```

Anything unusable — blank, non-numeric, zero, negative, fractional — reads as
"not configured" rather than as an error, so a typo can neither stop the server
nor be rounded into a limit nobody intended.

## How spend is counted

Spend is never a stored counter. It is summed from the append-only usage ledger
over the budget's window, so there is nothing to decrement concurrently,
nothing that can drift out of step with the events it summarises, and every
figure the guard acted on can be recomputed later from the same rows.

Per-subject budgets count within a monthly window anchored at the subject's
own start, turning over on that day each month; instance-wide budgets count
over a trailing window. The anchor keeps a counter from sliding: it resets on
a date the subject can be told in advance rather than drifting with the last
thirty days.

Checking and then spending is not atomic, so concurrent calls can carry a
budget slightly past its limit. That overshoot is accepted deliberately — the
alternative is a lock around every LLM call.

## Using it

```ts
const guard = new BudgetGuard([new EnvPolicyProvider()], spendMeter, {
  onDecision: (decision, context) => audit.record(decision, context),
});

await guard.require('extraction', { subjectId: userId });
```

`require` throws `BudgetExhaustedError` when the budget is used up. It throws
rather than returning an empty result on purpose: an empty extraction looks
like "nothing worth keeping" and would let the ingest ledger mark the chunk
done, losing it. A caller that cannot generate must find out, so the work can
be recorded as deferred and retried once the window rolls forward.

Calls made on credentials the caller supplied themselves
(`usesCallerCredentials: true`) skip every check, and their ledger rows stay
out of the sums above: a ceiling counts what this instance's own credential
consumed, and those calls did not touch it.
