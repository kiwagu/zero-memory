import { z } from 'zod';

import {
  JudgeUnavailableError,
  type IJudgment,
  type JudgmentRequest,
  type JudgmentResult,
  type NoulAnswer,
} from './judgment.port.js';

/**
 * SubQ Snap over plain `fetch`: the SubQ Decisions API, `POST /v1/systemone`
 * on `https://api.subq.ai` with `{ model, state, questions }` and a bearer
 * key. A question is discriminated by its `type`: a Noul is
 * `questions.<name> = { type: 'noul', instructions, criteria }`, and its
 * answer is `{ type: 'noul', noul }` with `noul` in 0..1. SubQ bills input
 * tokens only, so `usage.output_tokens` comes back as 0.
 */
const tokenCount = z.number().int().nonnegative();

const subqResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(
    z.string(),
    z.looseObject({ noul: z.number().min(0).max(1) })
  ),
  usage: z
    .object({ input_tokens: tokenCount, output_tokens: tokenCount })
    .optional(),
});

type SubqResponse = z.infer<typeof subqResponseSchema>;

/** Rate limit, overload, temporary outage: no verdict, not a bug. */
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([429, 503, 529]);

/** A body that does not match the wire shape is a bug, not unavailability. */
const parseResponse = (text: string): SubqResponse => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error('subq: malformed response: not JSON', { cause: error });
  }
  const parsed = subqResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `subq: malformed response: ${z.prettifyError(parsed.error)}`
    );
  }
  return parsed.data;
};

export class SubqJudgment implements IJudgment {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(options: {
    apiKey: string;
    model: string;
    fetch?: typeof fetch;
    baseUrl?: string;
  }) {
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#fetch = options.fetch ?? fetch;
    this.#baseUrl = (options.baseUrl ?? 'https://api.subq.ai').replace(
      /\/$/u,
      ''
    );
  }

  async judge(
    request: JudgmentRequest,
    options: { readonly timeoutMs?: number } = {}
  ): Promise<JudgmentResult> {
    const timeoutMs = options.timeoutMs ?? 1500;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    let response: Response;
    let text: string;
    // The timer bounds the whole exchange, body included: a provider that
    // sends headers and then stalls the body must still fail in time.
    try {
      response = await this.#fetch(`${this.#baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.#model,
          state: request.state,
          questions: Object.fromEntries(
            Object.entries(request.questions).map(([name, question]) => [
              name,
              {
                type: question.kind,
                instructions: question.instructions,
                criteria: question.criteria,
              },
            ])
          ),
        }),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      throw new JudgeUnavailableError(
        `subq: no answer within ${timeoutMs} ms`,
        error
      );
    } finally {
      clearTimeout(timer);
    }
    if (UNAVAILABLE_STATUSES.has(response.status)) {
      throw new JudgeUnavailableError(`subq: ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`subq: HTTP ${response.status}: ${text}`);
    }
    const body = parseResponse(text);
    // Only the questions asked get answers; one the judge left unanswered
    // stays absent.
    const answers: Record<string, NoulAnswer> = Object.fromEntries(
      Object.entries(body.answers)
        .filter(([name]) => Object.hasOwn(request.questions, name))
        .map(([name, answer]) => [name, { noul: answer.noul }])
    );
    return {
      answers,
      model: body.model ?? this.#model,
      provider: 'subq',
      usage: {
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
      },
      latencyMs: Math.round(performance.now() - started),
    };
  }
}
