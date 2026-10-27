import type {
  IJudgment,
  JudgmentRequest,
  JudgmentResult,
} from './judgment.port.js';
import {
  SystemOneExchange,
  type SystemOneOptions,
} from './system-one.exchange.js';

/**
 * SubQ Snap at `https://api.subq.ai`: the SubQ Decisions API speaks the
 * System One wire shape. SubQ bills input tokens only, so its
 * `usage.output_tokens` comes back as 0.
 */
export class SubqJudgment implements IJudgment {
  readonly #exchange: SystemOneExchange;

  constructor(options: SystemOneOptions) {
    this.#exchange = new SystemOneExchange(
      { provider: 'subq', defaultBaseUrl: 'https://api.subq.ai' },
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
