import type {
  IJudgment,
  JudgmentRequest,
  JudgmentResult,
} from './judgment.port.js';
import {
  SystemOneExchange,
  type SystemOneOptions,
} from './system-one.exchange.js';

/** TypeSafe System One (Jev models) at `https://api.typesafe.ai`. */
export class TypeSafeJudgment implements IJudgment {
  readonly #exchange: SystemOneExchange;

  constructor(options: SystemOneOptions) {
    this.#exchange = new SystemOneExchange(
      { provider: 'typesafe', defaultBaseUrl: 'https://api.typesafe.ai' },
      options
    );
  }

  judge(
    request: JudgmentRequest,
    options?: { readonly timeoutMs?: number }
  ): Promise<JudgmentResult> {
    return this.#exchange.judge(request, options);
  }
}
