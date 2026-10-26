import { describe, expect, it } from 'vitest';

import {
  JudgeUnavailableError,
  type IJudgment,
  type JudgeProviderName,
} from './judgment.port.js';
import { SubqJudgment } from './subq.adapter.js';
import { TypeSafeJudgment } from './typesafe.adapter.js';

interface AdapterOptions {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}

interface ProviderCase {
  provider: JudgeProviderName;
  make: (options: AdapterOptions) => IJudgment;
  url: string;
  model: string;
}

/** Every System One provider runs the same cases; only these values differ. */
const PROVIDERS: ProviderCase[] = [
  {
    provider: 'typesafe',
    make: (options) => new TypeSafeJudgment(options),
    url: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-1.14.0',
  },
  {
    provider: 'subq',
    make: (options) => new SubqJudgment(options),
    url: 'https://api.subq.ai/v1/systemone',
    model: 'subq-snap-1.1',
  },
];

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
    return new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      { status, headers: { 'content-type': 'application/json' } }
    );
  };

describe.each(PROVIDERS)('$provider over System One', (p) => {
  const judgeAnswering = (answers: unknown) =>
    p.make({
      apiKey: 'k',
      model: p.model,
      fetch: fetchReturning(200, {
        model: p.model,
        answers,
        usage: { input_tokens: 10, output_tokens: 0 },
      }),
    });

  it('posts state and questions to /v1/systemone with a bearer key and maps the noul answers', async () => {
    const seen: Seen = {};
    const judge = p.make({
      apiKey: 'the-key',
      model: p.model,
      fetch: fetchReturning(
        200,
        {
          model: `${p.model}-resolved`,
          answers: { r1: { type: 'noul', noul: 0.82 } },
          usage: { input_tokens: 412, output_tokens: 3 },
        },
        seen
      ),
    });
    const result = await judge.judge(request);
    expect(result.answers.r1?.noul).toBeCloseTo(0.82);
    expect(result.provider).toBe(p.provider);
    expect(result.model).toBe(`${p.model}-resolved`);
    expect(result.usage).toEqual({ inputTokens: 412, outputTokens: 3 });
    expect(seen.url).toBe(p.url);
    expect(seen.headers?.get('authorization')).toBe('Bearer the-key');
    expect(seen.body).toEqual({
      model: p.model,
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

  it('turns 429 and every 5xx into JudgeUnavailableError', async () => {
    for (const status of [429, 500, 503, 529, 599]) {
      const judge = p.make({
        apiKey: 'k',
        model: p.model,
        fetch: fetchReturning(status, { error: 'busy' }),
      });
      await expect(judge.judge(request), `HTTP ${status}`).rejects.toThrow(
        JudgeUnavailableError
      );
    }
  });

  it('rejects any other non-2xx as a plain error with its status and at most 200 characters of the body', async () => {
    for (const status of [400, 401, 422, 499]) {
      const body = { detail: { message: 'x'.repeat(500) } };
      const judge = p.make({
        apiKey: 'k',
        model: p.model,
        fetch: fetchReturning(status, body),
      });
      const error = await judge.judge(request).then(
        () => null,
        (rejection: unknown) => rejection
      );
      expect(error, `HTTP ${status}`).toBeInstanceOf(Error);
      expect(error, `HTTP ${status}`).not.toBeInstanceOf(JudgeUnavailableError);
      expect((error as Error).message).toBe(
        `${p.provider}: HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`
      );
    }
  });

  it('turns a timeout before the response into JudgeUnavailableError', async () => {
    const judge = p.make({
      apiKey: 'k',
      model: p.model,
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
    const judge = p.make({
      apiKey: 'k',
      model: p.model,
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
      `${p.provider}: malformed response`
    );
    await expect(judge.judge(request)).rejects.not.toBeInstanceOf(
      JudgeUnavailableError
    );
  });

  it('rejects a 200 whose body is not JSON as a malformed response', async () => {
    const judge = p.make({
      apiKey: 'k',
      model: p.model,
      fetch: fetchReturning(200, '<html>busy</html>'),
    });
    await expect(judge.judge(request)).rejects.toThrow(
      `${p.provider}: malformed response: not JSON`
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

  it('falls back to the configured model and zero usage when the response names neither', async () => {
    const judge = p.make({
      apiKey: 'k',
      model: p.model,
      fetch: fetchReturning(200, {
        answers: { r1: { type: 'noul', noul: 0.5 } },
      }),
    });
    const result = await judge.judge(request);
    expect(result.model).toBe(p.model);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
