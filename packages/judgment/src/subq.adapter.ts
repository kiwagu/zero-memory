import {
  JudgeUnavailableError,
  type IJudgment,
  type JudgmentRequest,
  type JudgmentResult,
} from './judgment.port.js';

/** SubQ Snap adapter. Filled in by the SubQ task; until then it reports itself unavailable. */
export class SubqJudgment implements IJudgment {
  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      fetch?: typeof fetch;
      baseUrl?: string;
    }
  ) {}

  judge(_request: JudgmentRequest): Promise<JudgmentResult> {
    void this.options;
    return Promise.reject(
      new JudgeUnavailableError('subq: adapter not implemented in this build')
    );
  }
}
