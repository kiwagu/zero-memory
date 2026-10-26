import { describe, expect, it } from 'vitest';

import { JudgeUnavailableError } from './judgment.port.js';
import { SubqJudgment } from './subq.adapter.js';

const request = {
  state: {
    task: 'squash the branch and release',
    rules: { r1: { headline: 'ONE LINE COMMITS' } },
  },
  questions: {
    r1: {
      kind: 'noul' as const,
      instructions: 'Does the rule `rules.r1` bind the task in `task`?',
      criteria: {
        true: 'the task will commit',
        false: 'the task touches no git history',
      },
    },
  },
  purpose: 'rule_gate' as const,
  subjectId: 'usr_test',
};

interface Seen {
  url?: string;
  body?: unknown;
  headers?: Headers;
}

const fetchReturning =
  (status: number, body: unknown, seen: Seen = {}) =>
  async (
    url: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    seen.url = String(url);
    seen.body = JSON.parse(String(init?.body));
    seen.headers = new Headers(init?.headers);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

const judgeAnswering = (answers: unknown) =>
  new SubqJudgment({
    apiKey: 'k',
    model: 'subq-snap-1.1',
    fetch: fetchReturning(200, {
      model: 'subq-snap-1.1',
      answers,
      usage: { input_tokens: 10, output_tokens: 0 },
    }),
  });

describe('SubqJudgment', () => {
  it('posts state and questions to the SubQ Decisions API and maps the noul answers', async () => {
    const seen: Seen = {};
    const judge = new SubqJudgment({
      apiKey: 'sq-key',
      model: 'subq-snap-1.1',
      fetch: fetchReturning(
        200,
        {
          model: 'subq-snap-1.1',
          answers: { r1: { type: 'noul', noul: 0.92 } },
          usage: { input_tokens: 477, output_tokens: 0 },
        },
        seen
      ),
    });
    const result = await judge.judge(request);
    expect(result.answers.r1?.noul).toBeCloseTo(0.92);
    expect(result.provider).toBe('subq');
    expect(result.model).toBe('subq-snap-1.1');
    expect(result.usage).toEqual({ inputTokens: 477, outputTokens: 0 });
    expect(seen.url).toBe('https://api.subq.ai/v1/systemone');
    expect(seen.headers?.get('authorization')).toBe('Bearer sq-key');
    expect(seen.body).toMatchObject({
      model: 'subq-snap-1.1',
      state: request.state,
      questions: {
        r1: {
          type: 'noul',
          instructions: request.questions.r1.instructions,
          criteria: request.questions.r1.criteria,
        },
      },
    });
  });

  it('turns 429, 529 and 503 into JudgeUnavailableError', async () => {
    for (const status of [429, 529, 503]) {
      const judge = new SubqJudgment({
        apiKey: 'k',
        model: 'subq-snap-1.1',
        fetch: fetchReturning(status, {
          detail: { error_type: 'busy', message: 'try later' },
        }),
      });
      await expect(judge.judge(request)).rejects.toBeInstanceOf(
        JudgeUnavailableError
      );
    }
  });

  it('turns a timeout into JudgeUnavailableError', async () => {
    const judge = new SubqJudgment({
      apiKey: 'k',
      model: 'subq-snap-1.1',
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        }),
    });
    await expect(
      judge.judge(request, { timeoutMs: 20 })
    ).rejects.toBeInstanceOf(JudgeUnavailableError);
  });

  it('bounds the body read too: a body that stalls past the timeout is unavailability', async () => {
    const judge = new SubqJudgment({
      apiKey: 'k',
      model: 'subq-snap-1.1',
      fetch: async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () =>
                controller.error(new DOMException('aborted', 'AbortError'))
              );
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
    });
    await expect(
      judge.judge(request, { timeoutMs: 20 })
    ).rejects.toBeInstanceOf(JudgeUnavailableError);
  });

  it('rejects another non-2xx as a plain error with its status (a bug, not unavailability)', async () => {
    const judge = new SubqJudgment({
      apiKey: 'k',
      model: 'subq-snap-1.1',
      fetch: fetchReturning(422, {
        detail: {
          error_type: 'validation_error',
          message: "questions/r1: must have required property 'criteria'",
        },
      }),
    });
    await expect(judge.judge(request)).rejects.toThrow(/subq: HTTP 422/);
    await expect(judge.judge(request)).rejects.not.toBeInstanceOf(
      JudgeUnavailableError
    );
  });

  it('rejects a noul outside 0..1 as a malformed response (a bug, not unavailability)', async () => {
    const judge = judgeAnswering({ r1: { type: 'noul', noul: 1.7 } });
    await expect(judge.judge(request)).rejects.toThrow(
      /subq: malformed response/
    );
    await expect(judge.judge(request)).rejects.not.toBeInstanceOf(
      JudgeUnavailableError
    );
  });

  it('keeps only the answers to questions that were asked', async () => {
    const result = await judgeAnswering({
      r1: { type: 'noul', noul: 0.7 },
      r9: { type: 'noul', noul: 0.4 },
    }).judge(request);
    expect(result.answers).toEqual({ r1: { noul: 0.7 } });
  });
});
