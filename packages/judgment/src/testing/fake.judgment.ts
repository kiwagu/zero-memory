import {
  JudgeUnavailableError,
  type IJudgment,
  type JudgmentRequest,
  type JudgmentResult,
} from '../judgment.port.js';

const MARKER = /\[p=(0(?:\.\d+)?|1(?:\.0+)?)\]/u;

/**
 * Deterministic judge for tests: a question is answered with the `[p=0.xx]`
 * marker found in the rule of the same name under `state.rules` (its
 * applies_when or text), else `defaultP` — the gate names each rule `r1`,
 * `r2`, … in both places. Only the questions asked get answers.
 * `mode: 'unavailable'` throws JudgeUnavailableError; `mode: 'slow'` waits
 * past any timeout the caller passes.
 */
export class FakeJudgment implements IJudgment {
  readonly calls: JudgmentRequest[] = [];
  /** The options of each call, index for index with `calls`. */
  readonly callOptions: { readonly timeoutMs?: number }[] = [];

  constructor(
    private readonly options: {
      mode?: 'answer' | 'unavailable' | 'slow';
      defaultP?: number;
    } = {}
  ) {}

  async judge(
    request: JudgmentRequest,
    options: { readonly timeoutMs?: number } = {}
  ): Promise<JudgmentResult> {
    this.calls.push(request);
    this.callOptions.push(options);
    if (this.options.mode === 'unavailable') {
      throw new JudgeUnavailableError('fake: unavailable');
    }
    if (this.options.mode === 'slow') {
      await new Promise((resolve) =>
        setTimeout(resolve, (options.timeoutMs ?? 1500) + 50)
      );
      throw new JudgeUnavailableError('fake: timed out');
    }
    const rules = (request.state.rules ?? {}) as Record<
      string,
      { applies_when?: string; text?: string }
    >;
    const answers: Record<string, { noul: number }> = {};
    for (const name of Object.keys(request.questions)) {
      const rule = rules[name];
      const marker = `${rule?.applies_when ?? ''} ${rule?.text ?? ''}`.match(
        MARKER
      );
      answers[name] = {
        noul: marker ? Number(marker[1]) : (this.options.defaultP ?? 0.5),
      };
    }
    return {
      answers,
      model: 'fake',
      provider: 'typesafe',
      // Token counts are whole numbers, as a real provider reports them.
      usage: {
        inputTokens: Math.ceil(JSON.stringify(request.state).length / 4),
        outputTokens: 0,
      },
      latencyMs: 1,
    };
  }
}
