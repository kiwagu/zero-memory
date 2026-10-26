import { z } from 'zod';

import {
  JudgeUnavailableError,
  type IJudgment,
  type JudgmentRequest,
  type JudgmentResult,
  type NoulAnswer,
} from './judgment.port.js';

/**
 * TypeSafe System One over plain `fetch`: `POST /v1/systemone` with
 * `{ model, state, questions }`, bearer key, answers keyed by question name.
 * The request body carries `questions.<name> = { type: 'noul', instructions,
 * criteria }` — a question is discriminated by its `type` — and the answer
 * carries `{ type: 'noul', noul }` with `noul` in 0..1.
 */
const tokenCount = z.number().int().nonnegative();

const typeSafeResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(
    z.string(),
    z.looseObject({ noul: z.number().min(0).max(1) })
  ),
  usage: z
    .object({ input_tokens: tokenCount, output_tokens: tokenCount })
    .optional(),
});

type TypeSafeResponse = z.infer<typeof typeSafeResponseSchema>;

/** A body that does not match the wire shape is a bug, not unavailability. */
const parseResponse = (text: string): TypeSafeResponse => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error('typesafe: malformed response: not JSON', {
      cause: error,
    });
  }
  const parsed = typeSafeResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `typesafe: malformed response: ${z.prettifyError(parsed.error)}`
    );
  }
  return parsed.data;
};

export class TypeSafeJudgment implements IJudgment {
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
    this.#baseUrl = (options.baseUrl ?? 'https://api.typesafe.ai').replace(
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
        `typesafe: no answer within ${timeoutMs} ms`,
        error
      );
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 429 || response.status === 529) {
      throw new JudgeUnavailableError(`typesafe: ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`typesafe: HTTP ${response.status}: ${text}`);
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
      provider: 'typesafe',
      usage: {
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
      },
      latencyMs: Math.round(performance.now() - started),
    };
  }
}
