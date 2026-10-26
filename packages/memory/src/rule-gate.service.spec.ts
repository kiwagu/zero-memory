import type { ContextRule } from '@workspace/contracts';
import { FakeJudgment } from '@workspace/judgment/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  deliverAtLevel,
  hookTaskStatement,
  levelFor,
  RuleGateService,
} from './rule-gate.service.js';

const id = (n: string) => `rlc_${n.padEnd(16, '0')}.0123456789`;
const rules: ContextRule[] = [
  {
    id: id('pin'),
    text: 'PINNED RULE. Always.',
    headline: 'PINNED RULE',
    pinned: true,
  },
  {
    id: id('commit'),
    text: 'ONE LINE COMMITS. Body text.',
    headline: 'ONE LINE COMMITS',
    pinned: false,
    applies_when: 'tasks that commit [p=0.9]',
  },
  {
    id: id('stand'),
    text: 'STAND ROLES. Body.',
    headline: 'STAND ROLES',
    pinned: false,
    applies_when: 'tasks that touch a stack [p=0.5]',
  },
  {
    id: id('north'),
    text: 'NORTH STAR. Body.',
    headline: 'NORTH STAR',
    pinned: false,
    applies_when: 'planning [p=0.1]',
  },
  {
    id: id('bare'),
    text: 'NO APPLIES WHEN. Body.',
    headline: 'NO APPLIES WHEN',
    pinned: false,
  },
];

const service = (
  overrides: {
    mode?: 'off' | 'shadow' | 'live';
    enabled?: boolean;
    judge?: FakeJudgment;
    credential?: unknown;
  } = {}
) => {
  const judge = overrides.judge ?? new FakeJudgment({ defaultP: 0.5 });
  const recorder = { record: vi.fn() };
  const svc = new RuleGateService(
    {
      read: vi.fn().mockResolvedValue({
        enabled: overrides.enabled ?? true,
        provider: null,
      }),
    },
    {
      resolve: vi.fn().mockResolvedValue(
        overrides.credential === undefined
          ? {
              provider: 'typesafe',
              apiKey: 'k',
              model: 'jev-1.14.0',
              ownedByCaller: false,
            }
          : overrides.credential
      ),
    },
    () => judge,
    recorder,
    { mode: overrides.mode ?? 'live', hi: 0.6, lo: 0.35, timeoutMs: 1500 }
  );
  return { svc, judge, recorder };
};

describe('levelFor / deliverAtLevel', () => {
  it('maps bands to levels', () => {
    expect(levelFor(0.9, { hi: 0.6, lo: 0.35 })).toBe('full');
    expect(levelFor(0.6, { hi: 0.6, lo: 0.35 })).toBe('full');
    expect(levelFor(0.5, { hi: 0.6, lo: 0.35 })).toBe('gate');
    expect(levelFor(0.1, { hi: 0.6, lo: 0.35 })).toBe('headline');
  });
  it('shapes a rule for its level without losing its name', () => {
    expect(deliverAtLevel(rules[1]!, 'headline')).toEqual({
      ...rules[1],
      text: 'ONE LINE COMMITS',
      level: 'headline',
      applies_when: undefined,
    });
    expect(deliverAtLevel(rules[1]!, 'gate')).toMatchObject({
      text: 'ONE LINE COMMITS',
      level: 'gate',
      applies_when: 'tasks that commit [p=0.9]',
    });
    expect(deliverAtLevel(rules[1]!, 'full')).toMatchObject({
      text: rules[1]!.text,
      level: 'full',
    });
  });
});

describe('RuleGateService.apply', () => {
  it('live: judges unpinned rules once, delivers by level, pinned first and whole', async () => {
    const { svc, judge } = service();
    const out = await svc.apply({
      rules,
      task: 'squash and release',
      subjectId: 'usr_a',
    });
    expect(judge.calls).toHaveLength(1);
    // The judge is held to the configured timeout.
    expect(judge.callOptions[0]).toEqual({ timeoutMs: 1500 });
    expect(Object.keys(judge.calls[0]!.questions)).toEqual([
      `rule_${id('commit')}`,
      `rule_${id('stand')}`,
      `rule_${id('north')}`,
      `rule_${id('bare')}`,
    ]);
    expect(out.rules.map((r) => [r.id, r.level])).toEqual([
      [id('pin'), 'full'],
      [id('commit'), 'full'],
      [id('stand'), 'gate'],
      [id('bare'), 'gate'],
      [id('north'), 'headline'],
    ]);
    expect(out.rules[0]!.text).toBe('PINNED RULE. Always.');
    expect(out.rules[4]!.text).toBe('NORTH STAR');
    expect(out.block).toMatchObject({
      mode: 'live',
      provider: 'typesafe',
      model: 'fake',
      judge_unavailable: false,
      levels: { full: 2, gate: 2, headline: 1 },
    });
    expect(out.block!.chars_baseline).toBeGreaterThan(
      out.block!.chars_delivered
    );
    expect(out.block!.rules.find((r) => r.id === id('pin'))!.p).toBeNull();
  });

  it("counts a rule's condition on both sides, so a headline is credited for dropping it", async () => {
    const { svc } = service();
    // stand → gate: 11 + 32 of 18 + 32; north → headline: 10 of 17 + 16.
    const out = await svc.apply({
      rules: [rules[2]!, rules[3]!],
      task: 't',
      subjectId: 'usr_a',
    });
    expect(out.block).toMatchObject({
      chars_baseline: 83,
      chars_delivered: 53,
    });
    expect(out.block!.rules.map((r) => [r.level, r.chars])).toEqual([
      ['gate', 43],
      ['headline', 10],
    ]);
  });

  it('shadow: delivery unchanged, levels recorded in the block only', async () => {
    const { svc } = service({ mode: 'shadow' });
    const out = await svc.apply({ rules, task: 't', subjectId: 'usr_a' });
    expect(out.rules).toEqual(rules);
    expect(out.block).toMatchObject({
      mode: 'shadow',
      levels: { full: 2, gate: 2, headline: 1 },
    });
    expect(out.block!.chars_delivered).toBe(out.block!.chars_baseline);
  });

  it('a call with no task statement (a hook briefing without a card) is never judged', async () => {
    const { svc, judge } = service();
    const out = await svc.apply({ rules, task: null, subjectId: 'usr_a' });
    expect(judge.calls).toHaveLength(0);
    expect(out).toEqual({ rules, block: null });
  });

  it('a hook briefing with a bound card is judged against the card, never the project name', async () => {
    const { svc, judge } = service();
    const task = hookTaskStatement({
      bound_card: {
        id: 'crd_0000000000000000.0000000000',
        number: 7,
        title: 'Teach the importer to read CSV',
        state: 'active',
        type: 'story',
        state_reason: 'implementing',
        refs: 0,
        updated_at: '2026-10-24T00:00:00Z',
      },
      active: 1,
      waiting: 0,
      lead: [],
      open_branches: [
        // The same number on another board: a branch belongs to its card id.
        {
          card_id: 'crd_2222222222222222.2222222222',
          number: 7,
          state: 'active',
          repo: 'other-tool',
          branch: 'feature/other-work',
        },
        {
          card_id: 'crd_0000000000000000.0000000000',
          number: 7,
          state: 'active',
          repo: 'quokka-tool',
          branch: 'feature/csv-import',
        },
      ],
    } as never);
    expect(task).toBe(
      'Continue card #7 (story, active): Teach the importer to read CSV. Status: implementing Branch: feature/csv-import.'
    );
    await svc.apply({ rules, task, subjectId: 'usr_a' });
    expect(judge.calls[0]!.state.task).toBe(task);
  });

  it('hookTaskStatement falls back to the continuation card and is null without any card', () => {
    expect(
      hookTaskStatement({
        bound_card: null,
        active: 0,
        waiting: 2,
        lead: [],
        continuation: {
          card: {
            id: 'crd_1111111111111111.1111111111',
            number: 6,
            title: 'Retire the old parser',
            state: 'waiting',
            type: 'task',
            state_reason: 'released v1.2.0',
          },
          last: [],
        },
      } as never)
    ).toBe(
      'Continue card #6 (task, waiting): Retire the old parser. Status: released v1.2.0'
    );
    expect(
      hookTaskStatement({
        bound_card: null,
        active: 0,
        waiting: 0,
        lead: [],
      } as never)
    ).toBeNull();
    expect(hookTaskStatement(null)).toBeNull();
  });

  it('off, disabled account, or no credential → unchanged, no judge call', async () => {
    for (const variant of [
      service({ mode: 'off' }),
      service({ enabled: false }),
      service({ credential: null }),
    ]) {
      const out = await variant.svc.apply({
        rules,
        task: 't',
        subjectId: 'usr_a',
      });
      expect(variant.judge.calls).toHaveLength(0);
      expect(out).toEqual({ rules, block: null });
    }
  });

  it('judge unavailable → unchanged delivery, flagged, nothing metered', async () => {
    const { svc, recorder } = service({
      judge: new FakeJudgment({ mode: 'unavailable' }),
    });
    const out = await svc.apply({ rules, task: 't', subjectId: 'usr_a' });
    expect(recorder.record).not.toHaveBeenCalled();
    expect(out.rules).toEqual(rules);
    expect(out.block).toMatchObject({
      judge_unavailable: true,
      levels: { full: 5, gate: 0, headline: 0 },
    });
  });

  it('a rule the judge did not answer stays full', async () => {
    const judge = new FakeJudgment();
    judge.judge = async () => ({
      answers: {},
      model: 'fake',
      provider: 'typesafe',
      usage: { inputTokens: 1, outputTokens: 0 },
      latencyMs: 1,
    });
    const { svc } = service({ judge });
    const out = await svc.apply({ rules, task: 't', subjectId: 'usr_a' });
    expect(out.rules.every((r) => r.level === 'full')).toBe(true);
    expect(
      out.block!.rules.filter((r) => !r.pinned).every((r) => r.p === null)
    ).toBe(true);
  });

  it('meters the judge tokens under purpose rule_gate', async () => {
    const { svc, recorder } = service();
    await svc.apply({ rules, task: 't', subjectId: 'usr_a' });
    expect(recorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'llm_extraction',
        unit: 'tokens',
        metadata: expect.objectContaining({
          purpose: 'rule_gate',
          provider: 'typesafe',
          model: 'fake',
          owned_by_caller: false,
        }),
      })
    );
  });
});
