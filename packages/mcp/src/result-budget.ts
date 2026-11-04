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
 * therefore fits its result to a budget before it leaves the server, through
 * steps the tool orders from most to least expendable: shorten long memory
 * text past the top hits (the full text stays one zm://memory read away), or
 * shed rows from the tail of a list, never below a floor. What was cut is
 * stated in the result (`fit`), so the agent can page for the rest instead of
 * taking a cut list for the whole one. What no step may cut stays whole, and
 * a result that is still too large says so rather than claiming to fit.
 */

/** One way a result gives way, applied only while it is still too large. */
export type FitStep =
  /**
   * Shorten the `content` of every row of `clip` past the top `keepWhole`
   * to `toChars`, marking the row `truncated`.
   */
  | {
      readonly clip: string;
      readonly keepWhole: number;
      readonly toChars: number;
    }
  /**
   * Shed rows from the tail of `drop`, down to `floor` (0 unless said).
   * `rowExtraChars` is what else a row costs besides its JSON, such as the
   * resource link a memory row brings.
   */
  | {
      readonly drop: string;
      readonly floor?: number;
      readonly rowExtraChars?: number;
    }
  /**
   * Deliver only the head of the text at `trim` (a dotted path), just as
   * much as fits and never less than `floor` characters. No ellipsis: the
   * caller hands out where the rest starts, and the parts join back exactly.
   */
  | { readonly trim: string; readonly floor: number }
  /**
   * Shrink something that rides beside the payload (a footer). `apply`
   * makes it smaller and returns the characters it saved; what it shortened
   * must still be reachable another way.
   */
  | { readonly compact: string; readonly apply: () => number };

/** A tool's steps, most expendable first. */
export type FitPlan = readonly FitStep[];

/**
 * Room kept free when a result is cut: the `fit` marker and the note that
 * names the cut still have to fit after the rows that made room for them.
 */
export const FIT_RESERVE_CHARS = 1_000;

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

const textAt = (payload: object, path: string): string | null => {
  let value: unknown = payload;
  for (const key of path.split('.')) {
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === 'string' ? value : null;
};

/** A copy of `payload` with the text at `path` replaced, nothing mutated. */
const withTextAt = (
  payload: Record<string, unknown>,
  path: string,
  text: string
): Record<string, unknown> => {
  const [key, ...rest] = path.split('.');
  if (key === undefined) {
    return payload;
  }
  if (rest.length === 0) {
    return { ...payload, [key]: text };
  }
  return {
    ...payload,
    [key]: withTextAt(
      payload[key] as Record<string, unknown>,
      rest.join('.'),
      text
    ),
  };
};

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

/** What the `fit` marker adds to a payload once it is attached. */
const markerChars = (fit: ResultFit): number => JSON.stringify({ fit }).length;

/**
 * Fits a payload to the budget. A payload inside it, its marker included,
 * comes back as it was. One past it is cut to the budget less
 * {@link FIT_RESERVE_CHARS}, step by step in the plan's order, stopping as
 * soon as it fits. When the steps run out first, the result goes out over
 * budget with `fit.delivered` saying so.
 */
export const fitResult = <P extends object>(input: FitInput<P>): Fitted<P> => {
  const { payload, budget, source, plan, measure } = input;
  const chars = measure(payload);
  const acknowledged: ResultFit = {
    budget,
    source,
    chars,
    delivered: chars,
    omitted: {},
    clipped: 0,
    cut: {},
  };
  // A reported limit is answered with the marker, so the marker counts.
  const cost = chars + (source === 'call' ? markerChars(acknowledged) : 0);
  if (cost <= budget) {
    return { payload, fit: source === 'call' ? acknowledged : null };
  }

  const target = Math.max(0, budget - FIT_RESERVE_CHARS);
  let out = { ...payload } as Record<string, unknown>;
  const omitted: Record<string, number> = {};
  const cut: Record<string, number> = {};
  let clipped = 0;
  let size = chars;
  for (const step of plan) {
    if (size <= target) {
      break;
    }
    if ('compact' in step) {
      const saved = step.apply();
      if (saved > 0) {
        cut[step.compact] = (cut[step.compact] ?? 0) + saved;
        size = measure(out as P);
      }
      continue;
    }
    if ('trim' in step) {
      const whole = textAt(out, step.trim);
      if (whole === null) {
        continue;
      }
      // Escaped characters make the JSON longer than the text, so a first
      // cut can fall short; measure again and cut once more if it did.
      let kept = whole.length;
      for (
        let pass = 0;
        pass < 3 && size > target && kept > step.floor;
        pass += 1
      ) {
        kept = Math.max(step.floor, kept - (size - target));
        out = withTextAt(out, step.trim, whole.slice(0, kept));
        size = measure(out as P);
      }
      if (kept < whole.length) {
        cut[step.trim] = (cut[step.trim] ?? 0) + (whole.length - kept);
      }
      continue;
    }
    if ('clip' in step) {
      const rows = rowsOf(out, step.clip);
      if (!rows) {
        continue;
      }
      out[step.clip] = rows.map((row, index) => {
        if (index < step.keepWhole) {
          return row;
        }
        const result = shortened(row, step.toChars);
        clipped += result.clipped ? 1 : 0;
        return result.row;
      });
      size = measure(out as P);
      continue;
    }
    const rows = rowsOf(out, step.drop);
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
      out[step.drop] = kept;
      omitted[step.drop] = (omitted[step.drop] ?? 0) + dropped;
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
      cut,
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
 * The note a fitted result carries in its footer: what was left out, how to
 * get it, and that the client can report its own limit. A result that is
 * still over its budget says so plainly. Null when nothing was cut and the
 * result fits.
 */
export const renderFitNote = (
  fit: ResultFit | null,
  more?: string
): string | null => {
  if (!fit) {
    return null;
  }
  const over = fit.delivered > fit.budget;
  const dropped = Object.entries(fit.omitted).map(
    ([list, count]) => `${count} ${list}`
  );
  const deferred = Object.entries(fit.cut).map(
    ([text, chars]) => `${formatChars(chars)} characters of ${text}`
  );
  if (
    dropped.length === 0 &&
    deferred.length === 0 &&
    fit.clipped === 0 &&
    !over
  ) {
    return null;
  }
  const cut = [
    ...(dropped.length > 0 ? [`left out ${dropped.join(', ')}`] : []),
    ...(fit.clipped > 0
      ? [`shortened ${fit.clipped} memories (full text: zm://memory/<id>)`]
      : []),
    ...(deferred.length > 0
      ? [`kept ${deferred.join(', ')} for a later read`]
      : []),
  ].join('; ');
  const head = over
    ? `NOTE: this result could not be held to ${formatChars(fit.budget)} ` +
      `characters: it is ${formatChars(fit.delivered)} ` +
      `(it was ${formatChars(fit.chars)})` +
      (cut ? `, after it ${cut}` : '') +
      '. What is left cannot be cut without losing it.'
    : `NOTE: this result was held to ${formatChars(fit.budget)} characters ` +
      `(it was ${formatChars(fit.chars)}): ${cut}.`;
  const advice =
    fit.source === 'default'
      ? ' If your client shows more inline, pass `max_chars` with its limit: ' +
        'ZM keeps it for the rest of this session.'
      : '';
  return head + (more ? ` ${more}` : '') + advice;
};
