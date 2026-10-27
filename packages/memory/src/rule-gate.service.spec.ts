import type { ContextRule } from '@workspace/contracts';
import { FakeJudgment } from '@workspace/judgment/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  deliverAtLevel,
  deliverUnjudged,
  hookTaskStatement,
  levelFor,
  RuleGateService,
  ruleGateRequest,
} from './rule-gate.service.js';

const id = (n: string) => `rlc_${n.padEnd(16, '0')}.0123456789`;
const rules: ContextRule[] = [
  {
    id: id('pin'),
    text: 'PINNED RULE FOR EVERY SESSION. Read the pinned rule before anything else.',
    pinned: true,
  },
  {
    id: id('commit'),
    text: 'ONE-LINE COMMITS (every project). The subject names the goal of the change.',
    pinned: false,
    applies_when: 'tasks that commit [p=0.9]',
  },
  {
    id: id('stack'),
    text: 'STACK ROLES ARE FIXED PER STACK. The test stack is disposable; the dev stack is not.',
    pinned: false,
    applies_when: 'tasks that touch a stack [p=0.5]',
  },
  {
    id: id('plan'),
    text: 'PLANNING NOTES COME FIRST. Write the plan down before the first edit.',
    pinned: false,
    applies_when: 'planning [p=0.1]',
  },
  {
    id: id('bare'),
    text: 'NO APPLIES WHEN ON THIS RULE. Without a condition it is judged on its text.',
    pinned: false,
  },
];
/** The rules as a call that nothing judged delivers them. */
const unjudged = rules.map(deliverUnjudged);

const service = (
  overrides: {
    mode?: 'off' | 'shadow' | 'live';
    enabled?: boolean;
    judge?: FakeJudgment;
    credential?: unknown;
    /** Whether the account's extraction allowance has room. */
    budgetLeft?: boolean;
  } = {}
) => {
  const judge = overrides.judge ?? new FakeJudgment({ defaultP: 0.5 });
  const recorder = { record: vi.fn() };
  const guard = {
    check: vi.fn().mockResolvedValue({ allowed: overrides.budgetLeft ?? true }),
  };
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
    guard,
    { mode: overrides.mode ?? 'live', hi: 0.6, lo: 0.35, timeoutMs: 1500 }
  );
  return { svc, judge, recorder, guard };
};

describe('levelFor / deliverAtLevel', () => {
  it('maps bands to levels', () => {
    expect(levelFor(0.9, { hi: 0.6, lo: 0.35 })).toBe('full');
    expect(levelFor(0.6, { hi: 0.6, lo: 0.35 })).toBe('full');
    expect(levelFor(0.5, { hi: 0.6, lo: 0.35 })).toBe('gate');
    expect(levelFor(0.1, { hi: 0.6, lo: 0.35 })).toBe('headline');
  });
  it('shapes a rule for its level without losing its name', () => {
    expect(deliverAtLevel(rules[1]!, 'headline')).toStrictEqual({
      id: id('commit'),
      text: 'ONE-LINE COMMITS (every project)',
      pinned: false,
      level: 'headline',
    });
    expect(deliverAtLevel(rules[1]!, 'gate')).toStrictEqual({
      id: id('commit'),
      text: 'ONE-LINE COMMITS (every project)',
      pinned: false,
      applies_when: 'tasks that commit [p=0.9]',
      level: 'gate',
    });
    // The condition is shown only on a gate line; a whole rule needs none.
    expect(deliverAtLevel(rules[1]!, 'full')).toStrictEqual({
      id: id('commit'),
      text: rules[1]!.text,
      pinned: false,
      level: 'full',
    });
    expect(deliverAtLevel(rules[4]!, 'gate')).toStrictEqual({
      id: id('bare'),
      text: 'NO APPLIES WHEN ON THIS RULE',
      pinned: false,
      level: 'gate',
    });
  });

  it('delivers an unjudged rule as its text, pin and id only', () => {
    expect(unjudged[1]).toStrictEqual({
      id: id('commit'),
      text: rules[1]!.text,
      pinned: false,
    });
    expect(
      deliverUnjudged({ text: 'ID-LESS RULE.', pinned: false })
    ).toStrictEqual({
      text: 'ID-LESS RULE.',
      pinned: false,
    });
  });
});

describe('ruleGateRequest', () => {
  it('asks about each rule by its condition, or by its text when it has none, keyed by id', () => {
    const conditioned = rules[1]! as ContextRule & { id: string };
    const unheaded = {
      id: id('unheaded'),
      text: 'ALWAYS RUN THE GATES FIRST. Then commit.',
      pinned: false,
    };

    const { state, questions } = ruleGateRequest('ship the release', [
      conditioned,
      unheaded,
    ]);

    expect(state).toEqual({
      task: 'ship the release',
      rules: {
        [conditioned.id]: {
          headline: 'ONE-LINE COMMITS (every project)',
          applies_when: 'tasks that commit [p=0.9]',
        },
        [unheaded.id]: {
          headline: 'ALWAYS RUN THE GATES FIRST',
          text: 'ALWAYS RUN THE GATES FIRST. Then commit.',
        },
      },
    });
    expect(Object.keys(state.rules as object)).toEqual([
      conditioned.id,
      unheaded.id,
    ]);
    expect(Object.keys(questions)).toEqual([
      `rule_${conditioned.id}`,
      `rule_${unheaded.id}`,
    ]);
    expect(questions[`rule_${unheaded.id}`]).toMatchObject({ kind: 'noul' });
    expect(questions[`rule_${unheaded.id}`]!.instructions).toContain(
      `\`rules.${unheaded.id}\``
    );
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
      `rule_${id('stack')}`,
      `rule_${id('plan')}`,
      `rule_${id('bare')}`,
    ]);
    expect(out.rules.map((r) => [r.id, r.level])).toEqual([
      [id('pin'), 'full'],
      [id('commit'), 'full'],
      [id('stack'), 'gate'],
      [id('bare'), 'gate'],
      [id('plan'), 'headline'],
    ]);
    expect(out.rules[0]!.text).toBe(rules[0]!.text);
    expect(out.rules[4]!.text).toBe('PLANNING NOTES COME FIRST');
    // Only the gated rule with a condition is sent one.
    expect(out.rules.map((r) => r.applies_when)).toEqual([
      undefined,
      undefined,
      'tasks that touch a stack [p=0.5]',
      undefined,
      undefined,
    ]);
    expect(out.block).toMatchObject({
      mode: 'live',
      provider: 'typesafe',
      model: 'fake',
      judge_unavailable: false,
      levels: { full: 2, gate: 2, headline: 1 },
    });
    // Whole texts 73 + 75 + 84 + 69 + 75; delivered 73 + 75 whole, the
    // stack gate 31 + 32, the bare gate 28, the planning headline 25.
    expect(out.block).toMatchObject({
      chars_baseline: 376,
      chars_delivered: 264,
    });
    expect(out.block!.rules.find((r) => r.id === id('pin'))!.p).toBeNull();
  });

  it('counts the whole texts against what the session receives, a condition only where sent', async () => {
    const { svc } = service();
    // stack → gate: 31 + 32 of 84; plan → headline: 25 of 69.
    const out = await svc.apply({
      rules: [rules[2]!, rules[3]!],
      task: 't',
      subjectId: 'usr_a',
    });
    expect(out.block).toMatchObject({
      chars_baseline: 153,
      chars_delivered: 88,
    });
    expect(out.block!.rules.map((r) => [r.level, r.chars])).toEqual([
      ['gate', 63],
      ['headline', 25],
    ]);
  });

  it('shadow: delivery as an unjudged call, levels recorded in the block only', async () => {
    const { svc } = service({ mode: 'shadow' });
    const out = await svc.apply({ rules, task: 't', subjectId: 'usr_a' });
    expect(out.rules).toStrictEqual(unjudged);
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
    expect(out).toStrictEqual({ rules: unjudged, block: null });
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
      expect(out).toStrictEqual({ rules: unjudged, block: null });
    }
  });

  it('judge unavailable → unchanged delivery, flagged, nothing metered', async () => {
    const { svc, recorder } = service({
      judge: new FakeJudgment({ mode: 'unavailable' }),
    });
    const out = await svc.apply({ rules, task: 't', subjectId: 'usr_a' });
    expect(recorder.record).not.toHaveBeenCalled();
    expect(out.rules).toStrictEqual(unjudged);
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

  it('meters the judge tokens under purpose rule_gate, as every model call is metered', async () => {
    const { svc, recorder, judge } = service();
    await svc.apply({ rules, task: 't', subjectId: 'usr_a' });
    const inputTokens = Math.ceil(
      JSON.stringify(judge.calls[0]!.state).length / 4
    );
    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(recorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'llm_extraction',
        quantity: inputTokens,
        unit: 'tokens',
        subjectId: 'usr_a',
        metadata: {
          input_tokens: inputTokens,
          output_tokens: 0,
          model: 'fake',
          provider: 'typesafe',
          purpose: 'rule_gate',
        },
      })
    );
  });

  it("marks a judgment on the account's own key, and never holds it back for the allowance", async () => {
    const { svc, recorder, guard, judge } = service({
      budgetLeft: false,
      credential: {
        provider: 'typesafe',
        apiKey: 'own',
        model: 'jev-1.14.0',
        ownedByCaller: true,
      },
    });
    const out = await svc.apply({ rules, task: 't', subjectId: 'usr_a' });
    expect(guard.check).not.toHaveBeenCalled();
    expect(judge.calls).toHaveLength(1);
    expect(out.block).toMatchObject({ judge_unavailable: false });
    expect(out.block).not.toHaveProperty('unavailable_reason');
    expect(recorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ own_key: true }),
      })
    );
  });

  it("asks nothing on the instance's key once the extraction allowance is used up", async () => {
    const { svc, recorder, guard, judge } = service({ budgetLeft: false });
    const out = await svc.apply({ rules, task: 't', subjectId: 'usr_a' });
    expect(guard.check).toHaveBeenCalledWith('extraction', {
      subjectId: 'usr_a',
    });
    expect(judge.calls).toHaveLength(0);
    expect(recorder.record).not.toHaveBeenCalled();
    expect(out.rules).toStrictEqual(unjudged);
    expect(out.block).toMatchObject({
      judge_unavailable: true,
      unavailable_reason: 'budget_exhausted',
      latency_ms: 0,
      levels: { full: 5, gate: 0, headline: 0 },
    });
  });

  it("judges on the instance's key while the allowance has room", async () => {
    const { svc, guard, judge } = service();
    const out = await svc.apply({ rules, task: 't', subjectId: 'usr_a' });
    expect(guard.check).toHaveBeenCalledTimes(1);
    expect(judge.calls).toHaveLength(1);
    expect(out.block).not.toHaveProperty('unavailable_reason');
  });
});
