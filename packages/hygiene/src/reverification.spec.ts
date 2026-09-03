import { setLlmGateway, WebSearchUnavailableError } from '@workspace/llm';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_REVERIFY_CONFIG,
  clearsReverifyGate,
  reverifyVerdictSchema,
} from './reverification.js';
import { ReverifyDetector } from './reverify-detector.js';
import { ReverifyJudge, type ReverifyJudgement } from './reverify-judge.js';

const OWNER = 'usr_000000000000000a.0000000000';
const MEMORY = 'mem_0000000000000001.0000000000';

describe('clearsReverifyGate', () => {
  const gate = DEFAULT_REVERIFY_CONFIG.minConfidence;

  it('acts on a confident verdict and discards a doubtful one', () => {
    const verdict = reverifyVerdictSchema.parse({
      verdict: 'outdated',
      confidence: 0.9,
    });
    expect(clearsReverifyGate(verdict, gate)).toBe(true);
    expect(
      clearsReverifyGate({ ...verdict, confidence: gate - 0.01 }, gate)
    ).toBe(false);
  });

  it('parses a minimal verdict (models omit no-signal fields)', () => {
    const parsed = reverifyVerdictSchema.parse({ verdict: 'current' });
    expect(parsed.confidence).toBe(0);
    expect(parsed.what_changed).toBe('');
  });
});

type Row = Record<string, unknown>;

/**
 * Minimal chainable fake of the service-role client covering exactly the
 * calls the detector makes: the rollup rpc, the verification-ledger read +
 * upsert, the review-queue insert, and usage_events / audit_log inserts.
 */
function fakeClient(rollupRows: Row[], existingChecks: number | null = null) {
  const upserts: Row[] = [];
  const inserts: Array<{ table: string; row: Row }> = [];
  const client = {
    rpc: () => Promise.resolve({ data: rollupRows, error: null }),
    from(table: string) {
      if (table === 'memory_verification') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data:
                    existingChecks === null ? null : { checks: existingChecks },
                  error: null,
                }),
            }),
          }),
          upsert: (row: Row) => {
            upserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      return {
        insert: (row: Row) => {
          inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client, upserts, inserts };
}

const rollupRow = (): Row => ({
  memory_id: MEMORY,
  owner_id: OWNER,
  kind: 'fact',
  content: 'Bun loads .env only from the cwd.',
  last_verified_at: null,
});

const judgement = (
  verdict: 'current' | 'outdated' | 'unverifiable',
  confidence: number
): ReverifyJudgement => ({
  verdict: {
    verdict,
    confidence,
    what_changed: verdict === 'outdated' ? 'Bun 2 loads parent .env too' : '',
    source_url: verdict === 'outdated' ? 'https://bun.sh/blog' : '',
    rationale: 'r',
  },
  sources: ['https://bun.sh/docs'],
  model: 'judge-model',
  inputTokens: 100,
  outputTokens: 20,
  ranOnCallerKey: false,
});

const judgeReturning = (result: ReverifyJudgement): ReverifyJudge =>
  ({ check: vi.fn().mockResolvedValue(result) }) as unknown as ReverifyJudge;

describe('ReverifyDetector', () => {
  it('stamps the ledger and audits on a confident current verdict', async () => {
    const { client, upserts, inserts } = fakeClient([rollupRow()], 2);
    const detector = new ReverifyDetector(
      client as never,
      judgeReturning(judgement('current', 0.9))
    );

    const result = await detector.detect();

    expect(result.current).toBe(1);
    expect(upserts[0]).toMatchObject({
      memory_id: MEMORY,
      verdict: 'current',
      checks: 3,
    });
    const audit = inserts.find((insert) => insert.table === 'audit_log');
    expect(audit?.row).toMatchObject({ command: 'reverify.current' });
  });

  it('raises a stale_suspect dispute on outdated — and does NOT stamp', async () => {
    const { client, upserts, inserts } = fakeClient([rollupRow()]);
    const detector = new ReverifyDetector(
      client as never,
      judgeReturning(judgement('outdated', 0.85))
    );

    const result = await detector.detect();

    expect(result.outdated).toBe(1);
    expect(upserts).toHaveLength(0);
    const dispute = inserts.find(
      (insert) => insert.table === 'memory_review_queue'
    );
    expect(dispute?.row).toMatchObject({
      memory_a: MEMORY,
      memory_b: null,
      verdict: 'stale_suspect',
    });
    expect(String(dispute?.row['rationale'])).toContain(
      'Bun 2 loads parent .env too'
    );
  });

  it('records nothing on a low-confidence verdict (inconclusive)', async () => {
    const { client, upserts, inserts } = fakeClient([rollupRow()]);
    const detector = new ReverifyDetector(
      client as never,
      judgeReturning(judgement('outdated', 0.3))
    );

    const result = await detector.detect();

    expect(result.inconclusive).toBe(1);
    expect(upserts).toHaveLength(0);
    expect(
      inserts.filter((insert) => insert.table === 'memory_review_queue')
    ).toHaveLength(0);
  });

  it('skips an owner without web search — audited, never stamped', async () => {
    const rows = [rollupRow(), { ...rollupRow(), memory_id: 'mem_2' }];
    const { client, upserts, inserts } = fakeClient(rows);
    const judge = {
      check: vi
        .fn()
        .mockRejectedValue(new WebSearchUnavailableError('deepseek')),
    } as unknown as ReverifyJudge;
    const detector = new ReverifyDetector(client as never, judge);

    const result = await detector.detect();

    expect(result.skippedUnsupported).toBe(2);
    // The second row of the same owner is skipped without another call.
    expect(judge.check).toHaveBeenCalledTimes(1);
    expect(upserts).toHaveLength(0);
    const audit = inserts.find(
      (insert) => insert.row['command'] === 'reverify.skip_unsupported'
    );
    expect(audit?.row['payload']).toMatchObject({ provider: 'deepseek' });
  });
});

describe('ReverifyJudge', () => {
  it('concludes nothing from an exhausted search (no classification call)', async () => {
    const callTool = vi.fn();
    setLlmGateway({
      callTool,
      searchWeb: () =>
        Promise.resolve({
          text: 'partial…',
          sources: [],
          exhausted: true,
          model: 'a-model',
          inputTokens: 50,
          outputTokens: 10,
          ranOnCallerKey: false,
        }),
    });

    const result = await new ReverifyJudge().check(
      { id: MEMORY, kind: 'fact', content: 'c' },
      OWNER,
      3
    );

    expect(result.verdict.verdict).toBe('unverifiable');
    expect(result.verdict.confidence).toBe(0);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('classifies the search report through the forced-schema pass', async () => {
    setLlmGateway({
      callTool: vi.fn().mockResolvedValue({
        input: { verdict: 'current', confidence: 0.9, rationale: 'ok' },
        model: 'a-model',
        inputTokens: 40,
        outputTokens: 8,
        ranOnCallerKey: false,
      }),
      searchWeb: vi.fn().mockResolvedValue({
        text: 'The docs confirm the behaviour.',
        sources: [{ url: 'https://bun.sh/docs', title: 'Bun docs' }],
        exhausted: false,
        model: 'a-model',
        inputTokens: 200,
        outputTokens: 60,
        ranOnCallerKey: true,
      }),
    });

    const result = await new ReverifyJudge().check(
      { id: MEMORY, kind: 'fact', content: 'c' },
      OWNER,
      3
    );

    expect(result.verdict.verdict).toBe('current');
    expect(result.sources).toEqual(['https://bun.sh/docs']);
    // Token totals cover both legs; the key flag follows the search leg.
    expect(result.inputTokens).toBe(240);
    expect(result.outputTokens).toBe(68);
    expect(result.ranOnCallerKey).toBe(true);
  });
});
