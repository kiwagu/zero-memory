import {
  RESULT_BUDGET,
  type ResultFit,
  type ResultFitSource,
} from '@workspace/contracts';

/**
 * Holding a read tool's result to what the client shows inline.
 *
 * A client that receives a result past its own line does not show it: it
 * saves it to a file and hands the agent a path to dig through, so the rules,
 * hits and cards in it are paid for and mostly unread. Every read tool
 * therefore fits its result to a budget before it leaves the server: it first
 * shortens long memory text past the top hits (the full text stays one
 * zm://memory read away), then sheds rows from the tails of its lists in an
 * order the tool chose, never below a floor. What was cut is stated in the
 * result (`fit`), so the agent can page for the rest instead of taking a cut
 * list for the whole one.
 */

/** How a tool's result may be fitted, in the order the steps apply. */
export interface FitPlan {
  /**
   * Memory rows whose `content` may be shortened: every row past the top
   * `keepWhole` of the list, cut to `toChars` and marked `truncated`.
   */
  clip?: readonly { list: string; keepWhole: number; toChars: number }[];
  /**
   * Lists shed from the tail, in this order, each down to `floor` rows (0
   * unless said). `rowExtraChars` is what else a row costs besides its JSON,
   * such as the resource link a memory row brings.
   */
  drop: readonly { list: string; floor?: number; rowExtraChars?: number }[];
}

/**
 * Room kept free when a result is cut: the `fit` marker and the note that
 * names the cut still have to fit after the rows that made room for them.
 */
export const FIT_RESERVE_CHARS = 600;

/** What a resource link costs as the client renders it, roughly. */
export const RESOURCE_LINK_CHARS = 100;

export interface FitInput<P> {
  payload: P;
  budget: number;
  source: ResultFitSource;
  plan: FitPlan;
  /** The whole result's size for a payload: its JSON plus what rides along. */
  measure: (payload: P) => number;
}

export interface Fitted<P> {
  payload: P;
  /** Null when nothing was cut and no `max_chars` was reported on this call. */
  fit: ResultFit | null;
}

const ELLIPSIS = '…';

const rowsOf = (payload: object, list: string): unknown[] | null => {
  const value = (payload as Record<string, unknown>)[list];
  return Array.isArray(value) ? value : null;
};

const shortened = (
  row: unknown,
  toChars: number
): { row: unknown; clipped: boolean } => {
  if (typeof row !== 'object' || row === null) {
    return { row, clipped: false };
  }
  const content = (row as { content?: unknown }).content;
  if (typeof content !== 'string' || content.length <= toChars) {
    return { row, clipped: false };
  }
  return {
    row: {
      ...row,
      content: content.slice(0, toChars) + ELLIPSIS,
      truncated: true,
    },
    clipped: true,
  };
};

/**
 * Fits a payload to the budget. A payload inside it comes back as it was.
 * One past it is cut to the budget less {@link FIT_RESERVE_CHARS}: content
 * first, then rows. When the floors stop the cut short, the result goes out
 * over budget with `fit.delivered` saying so — the caller logs that.
 */
export const fitResult = <P extends object>(input: FitInput<P>): Fitted<P> => {
  const { payload, budget, source, plan, measure } = input;
  const chars = measure(payload);
  if (chars <= budget) {
    return {
      payload,
      fit:
        source === 'call'
          ? { budget, source, chars, delivered: chars, omitted: {}, clipped: 0 }
          : null,
    };
  }

  const target = Math.max(0, budget - FIT_RESERVE_CHARS);
  const out = { ...payload } as Record<string, unknown>;
  let clipped = 0;
  for (const step of plan.clip ?? []) {
    const rows = rowsOf(out, step.list);
    if (!rows) {
      continue;
    }
    out[step.list] = rows.map((row, index) => {
      if (index < step.keepWhole) {
        return row;
      }
      const result = shortened(row, step.toChars);
      clipped += result.clipped ? 1 : 0;
      return result.row;
    });
  }

  let size = measure(out as P);
  const omitted: Record<string, number> = {};
  for (const step of plan.drop) {
    if (size <= target) {
      break;
    }
    const rows = rowsOf(out, step.list);
    if (!rows) {
      continue;
    }
    const kept = [...rows];
    const floor = step.floor ?? 0;
    let dropped = 0;
    while (size > target && kept.length > floor) {
      const removed = kept.pop();
      // The row's JSON, the comma that joined it to the one before, and
      // whatever else it brought along.
      size -=
        JSON.stringify(removed).length +
        (kept.length > 0 ? 1 : 0) +
        (step.rowExtraChars ?? 0);
      dropped += 1;
    }
    if (dropped > 0) {
      out[step.list] = kept;
      omitted[step.list] = (omitted[step.list] ?? 0) + dropped;
    }
  }

  const fitted = out as P;
  return {
    payload: fitted,
    fit: {
      budget,
      source,
      chars,
      delivered: measure(fitted),
      omitted,
      clipped,
    },
  };
};

/**
 * The budget a call is held to: what this call reported, else what an
 * earlier call of the session reported, else the default.
 */
export const resultBudgetFor = (
  reported: number | undefined,
  session: number | undefined
): { budget: number; source: ResultFitSource } => {
  if (reported !== undefined) {
    return { budget: reported, source: 'call' };
  }
  if (session !== undefined) {
    return { budget: session, source: 'session' };
  }
  return { budget: RESULT_BUDGET.defaultChars, source: 'default' };
};

const formatChars = (chars: number): string => chars.toLocaleString('en-US');

/**
 * The note a cut result carries in its footer: what was left out, how to get
 * it, and that the client can report its own limit. Null when nothing was
 * cut.
 */
export const renderFitNote = (
  fit: ResultFit | null,
  more?: string
): string | null => {
  if (!fit) {
    return null;
  }
  const dropped = Object.entries(fit.omitted).map(
    ([list, count]) => `${count} ${list}`
  );
  if (dropped.length === 0 && fit.clipped === 0) {
    return null;
  }
  const cut = [
    ...(dropped.length > 0 ? [`left out ${dropped.join(', ')}`] : []),
    ...(fit.clipped > 0
      ? [`shortened ${fit.clipped} memories (full text: zm://memory/<id>)`]
      : []),
  ].join('; ');
  const advice =
    fit.source === 'default'
      ? ' If your client shows more inline, pass `max_chars` with its limit: ' +
        'ZM keeps it for the rest of this session.'
      : '';
  return (
    `NOTE: this result was held to ${formatChars(fit.budget)} characters ` +
    `(it was ${formatChars(fit.chars)}): ${cut}.` +
    (more ? ` ${more}` : '') +
    advice
  );
};
