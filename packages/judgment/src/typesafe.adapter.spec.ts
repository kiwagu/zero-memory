import { describe, expect, it } from 'vitest';

import { JudgeUnavailableError } from './judgment.port.js';
import { TypeSafeJudgment } from './typesafe.adapter.js';

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

const fetchReturning =
  (
    status: number,
    body: unknown,
    seen: { body?: unknown; headers?: Headers }
  ) =>
  async (
    _url: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    seen.body = JSON.parse(String(init?.body));
    seen.headers = new Headers(init?.headers);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

const judgeAnswering = (answers: unknown) =>
  new TypeSafeJudgment({
    apiKey: 'k',
    model: 'jev-1.14.0',
    fetch: fetchReturning(
      200,
      {
        model: 'jev-1.14.0',
        answers,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
      {}
    ),
  });

describe('TypeSafeJudgment', () => {
  it('posts state and questions to /v1/systemone and maps the noul answers', async () => {
    const seen: { body?: unknown; headers?: Headers } = {};
    const judge = new TypeSafeJudgment({
      apiKey: 'ts-key',
      model: 'jev-1.14.0',
      fetch: fetchReturning(
        200,
        {
          model: 'jev-1.14.0',
          answers: { r1: { type: 'noul', noul: 0.82 } },
          usage: { input_tokens: 412, output_tokens: 3 },
        },
        seen
      ),
    });
    const result = await judge.judge(request);
    expect(result.answers.r1?.noul).toBeCloseTo(0.82);
    expect(result.provider).toBe('typesafe');
    expect(result.model).toBe('jev-1.14.0');
    expect(result.usage).toEqual({ inputTokens: 412, outputTokens: 3 });
    expect(seen.headers?.get('authorization')).toBe('Bearer ts-key');
    expect(seen.body).toMatchObject({
      model: 'jev-1.14.0',
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

  it('turns 429 and 529 into JudgeUnavailableError', async () => {
    for (const status of [429, 529]) {
      const judge = new TypeSafeJudgment({
        apiKey: 'k',
        model: 'jev-1.14.0',
        fetch: fetchReturning(status, { error: 'busy' }, {}),
      });
      await expect(judge.judge(request)).rejects.toBeInstanceOf(
        JudgeUnavailableError
      );
    }
  });

  it('turns a timeout into JudgeUnavailableError', async () => {
    const judge = new TypeSafeJudgment({
      apiKey: 'k',
      model: 'jev-1.14.0',
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

  it('rejects a 4xx other than 429 as a plain error (a bug, not unavailability)', async () => {
    const judge = new TypeSafeJudgment({
      apiKey: 'k',
      model: 'jev-1.14.0',
      fetch: fetchReturning(422, { error: 'malformed question' }, {}),
    });
    await expect(judge.judge(request)).rejects.toThrow(/422/);
    await expect(judge.judge(request)).rejects.not.toBeInstanceOf(
      JudgeUnavailableError
    );
  });

  it('bounds the body read too: a body that stalls past the timeout is unavailability', async () => {
    const judge = new TypeSafeJudgment({
      apiKey: 'k',
      model: 'jev-1.14.0',
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

  it('rejects a noul outside 0..1 as a malformed response (a bug, not unavailability)', async () => {
    const judge = judgeAnswering({ r1: { type: 'noul', noul: 1.7 } });
    await expect(judge.judge(request)).rejects.toThrow(
      /typesafe: malformed response/
    );
    await expect(judge.judge(request)).rejects.not.toBeInstanceOf(
      JudgeUnavailableError
    );
  });

  it('rejects a 200 whose body is not JSON as a malformed response', async () => {
    const judge = new TypeSafeJudgment({
      apiKey: 'k',
      model: 'jev-1.14.0',
      fetch: async () => new Response('<html>busy</html>', { status: 200 }),
    });
    await expect(judge.judge(request)).rejects.toThrow(
      /typesafe: malformed response/
    );
  });

  it('drops answers to questions that were never asked', async () => {
    const result = await judgeAnswering({
      r1: { type: 'noul', noul: 0.7 },
      r9: { type: 'noul', noul: 0.4 },
    }).judge(request);
    expect(result.answers).toEqual({ r1: { noul: 0.7 } });
  });

  it('leaves a question the judge did not answer absent from the answers', async () => {
    const result = await judgeAnswering({
      r1: { type: 'noul', noul: 0.7 },
    }).judge({
      ...request,
      questions: {
        ...request.questions,
        r2: {
          kind: 'noul',
          instructions: 'Is `task` about databases?',
          criteria: { true: 'it is', false: 'it is not' },
        },
      },
    });
    expect(result.answers).toEqual({ r1: { noul: 0.7 } });
    expect(result.answers).not.toHaveProperty('r2');
  });
});
