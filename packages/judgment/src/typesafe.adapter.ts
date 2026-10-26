import {
  JudgeUnavailableError,
  type IJudgment,
  type JudgmentRequest,
  type JudgmentResult,
} from './judgment.port.js';

/**
 * TypeSafe System One over plain `fetch`: `POST /v1/systemone` with
 * `{ model, state, questions }`, bearer key, answers keyed by question name.
 * The request body carries `questions.<name> = { type: 'noul', instructions,
 * criteria }` — a question is discriminated by its `type` — and the answer
 * carries `{ type: 'noul', noul }` with `noul` in 0..1.
 */
interface TypeSafeResponse {
  model?: string;
  answers?: Record<string, { type?: string; noul?: number }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

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
      throw new Error(
        `typesafe: HTTP ${response.status}: ${await response.text()}`
      );
    }
    const body = (await response.json()) as TypeSafeResponse;
    const answers: Record<string, { noul: number }> = {};
    for (const [name, answer] of Object.entries(body.answers ?? {})) {
      if (typeof answer?.noul === 'number') {
        answers[name] = { noul: answer.noul };
      }
    }
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
