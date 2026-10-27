import { z } from 'zod';

import {
  JudgeRequestError,
  JudgeUnavailableError,
  type IJudgment,
  type JudgeProviderName,
  type JudgmentRequest,
  type JudgmentResult,
  type NoulAnswer,
} from './judgment.port.js';

/**
 * One judgment over the System One wire shape, which TypeSafe and SubQ Snap
 * both speak: `POST <baseUrl>/v1/systemone` with `{ model, state, questions }`
 * and a bearer key. A question is discriminated by its `type`: a Noul is
 * `questions.<name> = { type: 'noul', instructions, criteria }`, and its
 * answer is `answers.<name> = { type: 'noul', noul }` with `noul` in 0..1.
 *
 * Status policy, the same for every provider:
 * - 429 and any 5xx (500–599) → `JudgeUnavailableError`: no verdict, try later;
 * - any other non-2xx → `JudgeRequestError` `<provider>: HTTP <status>: <body>`,
 *   the body cut to 200 characters, with the `status` on its own: the request
 *   is wrong, a retry won't help;
 * - no complete answer within the timeout, body read included →
 *   `JudgeUnavailableError`;
 * - a 2xx body that is not this shape → a plain `Error`: a bug, not
 *   unavailability.
 */
export interface SystemOneProvider {
  readonly provider: JudgeProviderName;
  readonly defaultBaseUrl: string;
}

export interface SystemOneOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

const DEFAULT_TIMEOUT_MS = 1500;
const ERROR_BODY_LIMIT = 200;

const tokenCount = z.number().int().nonnegative();

const systemOneResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(
    z.string(),
    z.looseObject({ noul: z.number().min(0).max(1) })
  ),
  usage: z
    .object({ input_tokens: tokenCount, output_tokens: tokenCount })
    .optional(),
});

type SystemOneResponse = z.infer<typeof systemOneResponseSchema>;

const isUnavailable = (status: number) =>
  status === 429 || (status >= 500 && status <= 599);

export class SystemOneExchange implements IJudgment {
  readonly #provider: JudgeProviderName;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(provider: SystemOneProvider, options: SystemOneOptions) {
    this.#provider = provider.provider;
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#fetch = options.fetch ?? fetch;
    this.#baseUrl = (options.baseUrl ?? provider.defaultBaseUrl).replace(
      /\/$/u,
      ''
    );
  }

  async judge(
    request: JudgmentRequest,
    options: { readonly timeoutMs?: number } = {}
  ): Promise<JudgmentResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
        `${this.#provider}: no answer within ${timeoutMs} ms`,
        error
      );
    } finally {
      clearTimeout(timer);
    }
    if (isUnavailable(response.status)) {
      throw new JudgeUnavailableError(`${this.#provider}: ${response.status}`);
    }
    if (!response.ok) {
      throw new JudgeRequestError(
        `${this.#provider}: HTTP ${response.status}: ${text.slice(0, ERROR_BODY_LIMIT)}`,
        response.status
      );
    }
    const body = this.#parseResponse(text);
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
      provider: this.#provider,
      usage: {
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
      },
      latencyMs: Math.round(performance.now() - started),
    };
  }

  /** A body that does not match the wire shape is a bug, not unavailability. */
  #parseResponse(text: string): SystemOneResponse {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new Error(`${this.#provider}: malformed response: not JSON`, {
        cause: error,
      });
    }
    const parsed = systemOneResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `${this.#provider}: malformed response: ${z.prettifyError(parsed.error)}`
      );
    }
    return parsed.data;
  }
}
