import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { DEFAULT_HOOK_BUDGET_CHARS } from '@workspace/client-core';
import {
  briefStatePath,
  callBuildContext,
  loadBriefState,
  markRulesDelivered,
  markTaskBriefed,
  projectScopeStatePath,
  readBriefTail,
  recordBriefTail,
  recordProjectScope,
  recordSessionBriefing,
  recordSessionThread,
  stampSessionStart,
} from '@workspace/client-runtime';
import type {
  BriefingWork,
  ContextMemory,
  ContextRule,
} from '@workspace/contracts';
import { cardIdSchema, memoryIdSchema } from '@workspace/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runBrief } from './brief-runner.js';
import { hookClient, type HookInput } from '../hook-client.js';
import { resolveProjectHint } from '../project-hint-resolver.js';
import { checkRelease } from '../release/release-runner.js';
import { git, initRepo } from '../testing/git-repo.fixture.js';
import { fakeHookClient } from '../testing/hook-client.fake.js';
import { useStateDirs, withEnv } from '../testing/state-dir.fixture.js';

vi.mock('@workspace/client-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@workspace/client-runtime')>()),
  callBuildContext: vi.fn(),
}));
vi.mock('../release/release-runner.js', () => ({ checkRelease: vi.fn() }));

// Every session-start briefing asks what production took; a real check would
// reach a real server, so it has nothing to say unless a test gives it a line.
beforeEach(() => {
  vi.mocked(checkRelease).mockReset().mockResolvedValue(null);
});
afterEach(() => {
  vi.mocked(callBuildContext).mockReset();
});

// A sweep drives the whole briefing once per channel size — a hundred or more
// runs in one test. That takes seconds on a workstation and several times
// longer on a shared CI runner, past the default five-second limit.
const SWEEP_TIMEOUT_MS = 60_000;

/** A substantive prompt: long enough, and not an acknowledgement. */
const SUBSTANTIVE =
  'add a retry with backoff to the ingest worker, it drops chunks';

/** This project's build_context answer: empty but for what a test fills in. */
const briefingPack = (
  fill: {
    memories?: ContextMemory[];
    rules?: ContextRule[];
    loops?: ContextMemory[];
    work?: BriefingWork;
  } = {}
) => ({
  memories: fill.memories ?? [],
  entities: [],
  edges: [],
  linked_memories: [],
  recent: [],
  rules: fill.rules ?? [],
  open_loops: fill.loops ?? [],
  open_loops_total: fill.loops?.length ?? 0,
  project_scope: 'proj.usr_x.demo',
  ...(fill.work ? { work: fill.work } : {}),
});

/** One briefing hook run; returns everything it put into the model's context. */
const brief = async (
  mode: 'task' | 'session-start',
  input: Partial<HookInput>
): Promise<string> => {
  const client = fakeHookClient({
    hookEventName: mode === 'task' ? 'UserPromptSubmit' : 'SessionStart',
    ...input,
  });
  await runBrief(mode, client);
  return client.emitted.join('\n');
};

/** `dir` as a project this machine already resolved to its scope. */
const resolvedProject = (dir: string): void =>
  recordProjectScope(
    projectScopeStatePath(),
    resolveProjectHint(dir),
    'proj.usr_x.demo'
  );

/**
 * Session start briefs the project and, on a branch worth a second lookup,
 * the branch as a topic of its own: which topic a real checkout yields is the
 * contract, read off the lookups the runner makes.
 */
describe('session-start branch topic', () => {
  const dirs = useStateDirs('zm-topic');

  const topicsOn = async (...checkout: string[]): Promise<string[]> => {
    initRepo(dirs.work, { branch: 'trunk-placeholder' });
    git(dirs.work, 'checkout', '-q', ...checkout);
    vi.mocked(callBuildContext).mockResolvedValue(briefingPack());
    await brief('session-start', { sessionId: 'sess-topic', cwd: dirs.work });
    return vi
      .mocked(callBuildContext)
      .mock.calls.map(([args]) => String(args.topic));
  };

  it.each([
    ['feature/ui-extractor-settings', 'ui extractor settings'],
    ['feature/watcher-brief/hooks', 'watcher brief hooks'],
    ['spike-oauth', 'spike oauth'],
  ])('briefs the branch %s as the topic "%s"', async (branch, topic) => {
    expect(await topicsOn('-b', branch)).toEqual([basename(dirs.work), topic]);
  });

  it.each(['main', 'dev', 'stage', 'master'])(
    'briefs the project alone on the trunk branch %s',
    async (branch) => {
      expect(await topicsOn('-b', branch)).toEqual([basename(dirs.work)]);
    }
  );

  it('briefs the project alone on a detached HEAD', async () => {
    expect(await topicsOn('--detach')).toEqual([basename(dirs.work)]);
  });
});

/**
 * The per-message assertion, driven end to end through `runBrief('task', …)`.
 *
 * An acknowledgement prompt is deliberate: the runner emits the banner and
 * then returns before any server call, so these exercise the real wiring —
 * which state the banner reads — with no network and no stubs in between.
 */
describe('per-message project/thread banner', () => {
  const dirs = useStateDirs('zm-banner');

  const bannerFor = (sessionId: string): Promise<string> =>
    brief('task', { sessionId, cwd: dirs.work, prompt: 'ok' });

  beforeEach(() => resolvedProject(dirs.work));

  it('gives each conversation in one repo its own token', async () => {
    recordSessionThread(briefStatePath(), 'sess-1', 'thr_one.01a');
    recordSessionThread(briefStatePath(), 'sess-2', 'thr_two.01b');

    // The regression: with the token kept per project, the session briefed
    // last owned the slot and BOTH banners quoted 'thr_two'.
    expect(await bannerFor('sess-1')).toContain('THREAD: thr_one.01a');
    expect(await bannerFor('sess-2')).toContain('THREAD: thr_two.01b');
    expect(await bannerFor('sess-1')).not.toContain('thr_two.01b');
  });

  it('states the project alone when this session has no token yet', async () => {
    recordSessionThread(briefStatePath(), 'sess-other', 'thr_other.01c');

    const banner = await bannerFor('sess-fresh');
    expect(banner).toContain('PROJECT: proj.usr_x.demo');
    expect(banner).not.toContain('THREAD:');
  });

  it('says nothing at all until the repo has a resolved project', async () => {
    rmSync(projectScopeStatePath(), { force: true });

    expect(await bannerFor('sess-1')).toBe('');
  });

  it('tells the agent to make the task lookup itself', async () => {
    // The hook stopped guessing a topic from the prompt, so the pack it
    // carries is the PROJECT's. This line is what replaces the guess — and it
    // has to survive, which is why it sits ahead of the droppable sections.
    const sessionId = 'sess-instruct';
    recordSessionThread(briefStatePath(), sessionId, 'thr_instruct.01e');
    vi.mocked(callBuildContext).mockResolvedValue(
      briefingPack({
        memories: [
          {
            id: memoryIdSchema.parse('mem_0000000000000002.0000000000'),
            content: 'a project-level fact',
            kind: 'fact',
            scope: 'proj.usr_x.demo',
            created_at: '2026-08-18T00:00:00Z',
            score: 0.5,
          },
        ],
      })
    );

    const text = await brief('task', {
      sessionId,
      cwd: dirs.work,
      prompt: SUBSTANTIVE,
    });

    expect(text).toContain('call build_context yourself');
    expect(text).toContain('English topic');
    // And the pack is labelled for what it actually is — the project — rather
    // than for a task nobody looked up.
    expect(text).toContain(basename(dirs.work));
    // The prompt itself never reaches the server.
    const sent = vi.mocked(callBuildContext).mock.calls[0]?.[0];
    expect(sent?.topic).toBe(basename(dirs.work));
  });

  it('sends nothing and asks the server nothing on a client with no task-brief channel', async () => {
    // Cursor's prompt event has no model-context channel, so its task
    // briefing is skipped outright rather than built for nowhere: not the
    // banner, not a drained chunk, not a server call.
    recordSessionThread(briefStatePath(), 'sess-cursor', 'thr_cursor.01f');
    const cursor = hookClient('cursor');
    const client = fakeHookClient(
      {
        sessionId: 'sess-cursor',
        cwd: dirs.work,
        prompt: SUBSTANTIVE,
        hookEventName: 'beforeSubmitPrompt',
      },
      { kind: cursor.kind, canTaskBrief: cursor.canTaskBrief }
    );

    await runBrief('task', client);

    expect(client.emitted).toEqual([]);
    expect(callBuildContext).not.toHaveBeenCalled();
  });

  it('rebriefs after compaction and emits one Codex frame with the same thread', async () => {
    const sessionId = 'sess-compact';
    recordSessionThread(briefStatePath(), sessionId, 'thr_compact.01d');
    markTaskBriefed(briefStatePath(), sessionId);
    markRulesDelivered(briefStatePath(), sessionId);
    stampSessionStart(briefStatePath(), sessionId, 200, 'compact');
    vi.mocked(callBuildContext).mockResolvedValue({
      ...briefingPack({
        memories: [
          {
            id: memoryIdSchema.parse('mem_0000000000000001.0000000000'),
            content: 'context restored after compaction',
            kind: 'fact',
            scope: 'proj.usr_x.demo',
            created_at: '2026-08-17T00:00:00Z',
            score: 0.5,
          },
        ],
      }),
      session: {
        attached_project: 'proj.usr_x.demo',
        thread: 'thr_compact.01d',
      },
    });
    const client = fakeHookClient({
      sessionId,
      cwd: dirs.work,
      prompt: 'restore the exact working context after compaction',
      hookEventName: 'UserPromptSubmit',
    });

    await runBrief('task', client);

    expect(client.emitted).toHaveLength(1);
    expect(client.emitted[0]).toContain('THREAD: thr_compact.01d');
    expect(client.emitted[0]).toContain('context restored after compaction');
    expect(loadBriefState(briefStatePath())[sessionId]?.task_briefed).toBe(
      true
    );
  });
});

/**
 * The session-start briefing keeps a floor for the memory pack even when the
 * standing rules run long, and records whatever did not fit as this window's
 * tail — driven end to end through `runBrief('session-start', …)` exactly
 * like the banner suite above drives `runBrief('task', …)`, with no mid-level
 * helper mocked out.
 */
// Fixtures shared by the two memory-floor suites below. Realistic mem_ ids:
// entity-id's Crockford base32 shape (16 chars, a dot, 10 chars) — a literal
// id like 'mem_a' fails buildContextOutputSchema and would make every fixture
// silently degrade to the "did not parse" branch of renderPackWithinBudget
// instead of exercising the budget logic these tests are about.
const memory = (index: number, contentChars: number): ContextMemory => ({
  id: memoryIdSchema.parse(
    `mem_${String(index).padStart(16, '0')}.${'0'.repeat(10)}`
  ),
  content: 'm'.repeat(contentChars),
  kind: 'fact',
  scope: 'proj.usr_x.demo',
  created_at: '2026-09-01T00:00:00Z',
  score: 0.5,
});

const loop = (index: number, contentChars: number): ContextMemory => ({
  id: memoryIdSchema.parse(
    `mem_${String(index).padStart(16, '0')}.${'1'.repeat(10)}`
  ),
  content: 'l'.repeat(contentChars),
  kind: 'task',
  scope: 'proj.usr_x.demo',
  created_at: '2026-09-01T00:00:00Z',
  score: 0.5,
});

const pinnedRule = (textChars: number): ContextRule => ({
  text: 'R'.repeat(textChars),
  pinned: true,
});

const rule = (textChars: number): ContextRule => ({
  text: 'r'.repeat(textChars),
  pinned: false,
});

describe('session-start memory floor', () => {
  const dirs = useStateDirs('zm-floor');
  const SESSION_ID = 'session-1';

  const runSessionStart = async (fixture: {
    rules?: ContextRule[];
    loops?: ContextMemory[];
    memories?: ContextMemory[];
    /**
     * When set, the work directory becomes a real git repo on this branch
     * BEFORE the hook runs, so `callBuildContext` is called twice (project,
     * then branch) — the only way to reach the cross-topic channel math at
     * all: outside a repository there is no branch and one topic.
     */
    branch?: string;
    /** The SECOND (branch) topic's memories, only used with `branch`. */
    branchMemories?: ContextMemory[];
    /** Overrides `ZM_BRIEF_HOOK_BUDGET_CHARS` for this call, restored after. */
    budgetChars?: number;
  }): Promise<string> => {
    const project = briefingPack(fixture);
    if (fixture.branch) {
      initRepo(dirs.work, { branch: fixture.branch });
      // The branch call carries no rules/loops of its own — this suite's
      // two-topic test is about how the PACK budget splits, and reusing the
      // project's rules/loops here would just dedupe back to the same
      // numbers via mergeStandingRules/mergeOpenLoops, adding nothing.
      vi.mocked(callBuildContext)
        .mockResolvedValueOnce(project)
        .mockResolvedValueOnce(
          briefingPack({ memories: fixture.branchMemories })
        );
    } else {
      vi.mocked(callBuildContext).mockResolvedValue(project);
    }
    const run = () =>
      brief('session-start', { sessionId: SESSION_ID, cwd: dirs.work });
    return fixture.budgetChars === undefined
      ? run()
      : withEnv('ZM_BRIEF_HOOK_BUDGET_CHARS', String(fixture.budgetChars), run);
  };

  it('keeps room for the memory pack even when the rules are long', async () => {
    // Sized so the rules alone (one pinned, one long enough to survive the
    // OLD unfloored ceiling in full) plus a wide spread of loops spend the
    // channel down to single digits for the one remaining topic — the exact
    // shape of the measured production defect: the pack gets nothing.
    const briefing = await runSessionStart({
      rules: [pinnedRule(200), rule(5_500)],
      loops: Array.from({ length: 20 }, (_, i) => loop(900 + i, 200)),
      memories: Array.from({ length: 12 }, (_, i) => memory(i, 900)),
    });
    // Before the fix, this much rules+loops content left the pack NOTHING —
    // not even the id of the memory that led the ranked results.
    expect(briefing).toContain('mem_0000000000000000');
    expect(briefing.length).toBeLessThanOrEqual(9_000);
  });

  it('delivers the pinned rules whole and the loops beside the rest by headline', async () => {
    // The measured defect: 8,455 characters of rules against the 9,000
    // channel — the loops got nothing, and then the rules did not fit either.
    // Split before anything renders, the pinned rules arrive whole, the
    // ordinary ones by headline, and the loops keep their floor.
    const longRule = (headline: string, pinned: boolean): ContextRule => ({
      text: `${headline}. ${'Why it holds, at length. '.repeat(55)}`,
      pinned,
    });
    const rules = [
      longRule('PINNED ONE', true),
      longRule('PINNED TWO', true),
      ...['THREE', 'FOUR', 'FIVE', 'SIX'].map((n) =>
        longRule(`ORDINARY ${n}`, false)
      ),
    ];
    const loops = [1, 2, 3].map((n) => loop(900 + n, 60));

    const briefing = await runSessionStart({ rules, loops });

    expect(briefing.length).toBeLessThanOrEqual(9_000);
    expect(briefing).toContain(rules[0]!.text);
    expect(briefing).toContain(rules[1]!.text);
    expect(briefing).not.toContain(rules[5]!.text);
    expect(briefing).toMatch(/ORDINARY SIX[^\n]*\[headline\]/u);
    for (const handover of loops) expect(briefing).toContain(handover.id);
    expect(briefing).not.toContain('did not fit');
  });

  it('records no tail when the project has no memories at all', async () => {
    const briefing = await runSessionStart({ memories: [] });
    expect(readBriefTail(briefStatePath(), SESSION_ID)).toBeNull();
    // Half of "no tail" is the state file; the other half is what the
    // session actually reads. An empty project has nothing to say, which is
    // a different claim from "it had memories and none fit" — the starved
    // notice must not appear just because the pack happened to be empty.
    expect(briefing).not.toContain('did not fit this briefing');
  });

  it('charges the floor to the split instead of bumping it on top, so a second topic still fits', async () => {
    // Two topics, no rules or loops — the only thing competing for the
    // channel is the two packs, isolating the cross-topic arithmetic this
    // test exists to pin. 12 large (2,000-char) primary memories spend
    // almost the whole primary pack budget on their own (leaving little
    // slack for a wrongly-unfunded bump to quietly eat), and 5 branch
    // memories give the branch pack enough supply that an OVER-sized
    // budget (the old, uncharged evenShare) and a correctly-charged one
    // produce visibly different results rather than both maxing out on
    // the same single item.
    //
    // 2,409 is this shape's original 2,208 plus the 201 characters the
    // primary's floor grew by once it began seating the stub block's own
    // intro and "+N more" line: the same room is left for the branch pack as
    // before, and with the floor uncharged no budget from 2,200 to 2,700
    // passes, so the number does not decide what the test pins.
    const briefing = await runSessionStart({
      branch: 'feature/two-topics',
      budgetChars: 2_409,
      memories: Array.from({ length: 12 }, (_, i) => memory(i, 2_000)),
      branchMemories: Array.from({ length: 5 }, (_, i) => memory(500 + i, 900)),
    });
    expect(briefing.length).toBeLessThanOrEqual(2_409);
    // The primary pack's floor-guaranteed memory…
    expect(briefing).toContain('mem_0000000000000000');
    // …and the branch pack's own memory, NOT displaced by the primary
    // taking more than its charged share. Before the fix, the primary's
    // bump was funded from nowhere, so the OTHER topic still asked for its
    // full (uncharged) even share — and `composeWithinBudget` (strict
    // priority order), finding the total no longer fit, dropped the branch
    // pack wholesale instead of giving it what was actually left.
    expect(briefing).toContain('mem_0000000000000500');
    // …and the primary floor is still charged in full: 2,000-character
    // memories only arrive by stub here, and the even (un-bumped) share alone
    // falls short of a stub list long enough to reach the eighth of them.
    expect(briefing).toContain('mem_0000000000000007');
  });

  it('shows the starved notice when the pack is squeezed to literal zero', async () => {
    // A channel so small that the project line leaves the pack less than
    // one stub of this 2,000-character memory needs: NOT EVEN A STUB fits,
    // which is the one case the notice exists for — a trimmed pack that
    // produced no text at all, as opposed to one that still named its
    // memories by stub. The pool is below the floor here (one memory's
    // floor seats its stub block), so this also pins that the pack renders
    // into what is left rather than being budgeted its floor, filling it
    // with a stub, and being dropped whole by the composer.
    const briefing = await runSessionStart({
      budgetChars: 700,
      memories: [memory(0, 2_000)],
    });
    expect(briefing.length).toBeLessThanOrEqual(700);
    // The specific starved-pack notice, not `composeWithinBudget`'s own
    // generic omission line — the two share the opening clause ("did not
    // fit this briefing"), so the assertion pins the wording that is
    // unique to `renderStarvedPackNotice`.
    expect(briefing).toContain('they arrive in the next messages');
    expect(briefing).not.toContain('mem_0000000000000000');
  });

  it('holds the memory floor against the open loops, even with one topic', async () => {
    // Single topic (no branch): abundant loops — far more than the channel
    // could ever render — used to be free to spend the room this floor
    // reserves, because the loops' own budget never subtracted it. Enough
    // loops here to consume the ENTIRE remainder if given the chance.
    const briefing = await runSessionStart({
      loops: Array.from({ length: 60 }, (_, i) => loop(900 + i, 200)),
      memories: Array.from({ length: 12 }, (_, i) => memory(i, 900)),
    });
    expect(briefing.length).toBeLessThanOrEqual(9_000);
    // Nothing here outranks the floor (no pinned rules), so the pack must
    // still NAME its lead memory: the starved notice alone would mean the
    // loops took the room the floor was supposed to hold.
    expect(briefing).toContain('mem_0000000000000000');
  });

  it(
    "reserves the composer's own per-section join cost, so a pack filled to its budget still lands",
    async () => {
      // Single topic, no rules or loops: the project line is the only other
      // section, so this isolates the composer's `+2`-per-section accounting
      // from everything else this suite already covers. Sixty identical,
      // tiny memories give the pack a DETERMINISTIC, small (~50-char) stub
      // line cost with abundant supply — enough that across the swept budgets
      // below, some of them land the render within just a few characters of
      // its own allotted budget, which is exactly the margin an unreserved
      // composer join cost eats. Swept rather than a single hand-picked
      // number because the exact margin depends on the project line's own
      // length, which this suite does not control (it comes from the work
      // directory's real, environment-chosen tmp path) — sweeping finds it
      // regardless.
      //
      // The range starts comfortably above `projectLine.length + memoryFloor`
      // (the floor is ten stubs plus the stub block's intro — 1,601 for 60
      // memories — and the project line runs ~500) so the memory floor is
      // never the reason a budget is tight — only the composer's own
      // per-section accounting is under test here. It sat at 2,000–2,100
      // until the floor grew by 201 to seat that intro; it moved up by as much.
      const memories = Array.from({ length: 60 }, (_, i) => memory(i, 3));
      for (let budgetChars = 2_201; budgetChars <= 2_301; budgetChars += 1) {
        const briefing = await runSessionStart({ budgetChars, memories });
        expect(
          briefing.length,
          `budget ${budgetChars}: briefing is ${briefing.length} chars`
        ).toBeLessThanOrEqual(budgetChars);
        const hasMemorySection =
          briefing.includes('mem_0000000000000000') ||
          briefing.includes('they arrive in the next messages');
        expect(
          hasMemorySection,
          `budget ${budgetChars}: no stub and no starved notice`
        ).toBe(true);
      }
    },
    SWEEP_TIMEOUT_MS
  );
});

/**
 * The per-message task briefing holds the same memory floor as the session-
 * start one, driven end to end through `runBrief('task', …)`. It is not a
 * second-class path: the FIRST briefing of a context window is a task
 * briefing whenever the session-start briefing failed or a compaction just
 * opened a new window, so a floor held on only one of the two paths is held
 * in only some windows.
 */
describe('task briefing memory floor', () => {
  // The topic this briefing is about is the work directory's basename, and
  // the starved-notice test below sizes its channel around the topic's
  // length: a fixed prefix keeps it the same on every machine.
  const dirs = useStateDirs('zm-task-floor');
  // `runTask` builds a briefing at most once per session (`task_briefed`),
  // so every run here is its own session: a shared id would turn every run
  // after the first into 'already-briefed' and never reach the budget code.
  let runs = 0;

  /** The composer's omission line, as it reads when it drops the pack. */
  const PACK_DROPPED = "the memory pack did not fit this briefing's channel";

  const runTask = async (fixture: {
    rules?: ContextRule[];
    loops?: ContextMemory[];
    memories?: ContextMemory[];
    /** Overrides `ZM_BRIEF_HOOK_BUDGET_CHARS` for this call, restored after. */
    budgetChars?: number;
  }): Promise<string> => {
    vi.mocked(callBuildContext).mockResolvedValue(briefingPack(fixture));
    runs += 1;
    const run = () =>
      brief('task', {
        sessionId: `task-session-${runs}`,
        cwd: dirs.work,
        prompt: SUBSTANTIVE,
      });
    return fixture.budgetChars === undefined
      ? run()
      : withEnv('ZM_BRIEF_HOOK_BUDGET_CHARS', String(fixture.budgetChars), run);
  };

  it('keeps a stub of its pack even when the rules and the loops are long', async () => {
    // The session-start suite's long-rules shape, on the task path: one
    // pinned rule, a spread of loops, and one ordinary rule sized to arrive
    // WHOLE under a ceiling that holds no memory floor and only by headline
    // under one that does. Before the task path passed its pack's memory
    // count, the plan held no floor: the rule took ~5,500 characters, the
    // loops the rest, and the pack nothing. (5,000 rather than the other
    // suite's 5,500: this path's lead — banner plus task-lookup line — runs
    // ~250 characters longer, so 5,500 is headlined even without a floor
    // and would not tell the two apart.)
    const briefing = await runTask({
      rules: [pinnedRule(200), rule(5_000)],
      loops: Array.from({ length: 20 }, (_, i) => loop(900 + i, 200)),
      memories: Array.from({ length: 12 }, (_, i) => memory(i, 900)),
    });
    expect(briefing.length).toBeLessThanOrEqual(9_000);
    expect(briefing).toContain('mem_0000000000000000');
    expect(briefing).not.toContain(PACK_DROPPED);
  });

  it('shows the starved notice when the pack is squeezed to literal zero', async () => {
    // The lead here is the banner (581 characters for this scope) and the
    // task-lookup line (156), with their joins ~741, so a 975-character
    // channel leaves the pack ~232. That sits between the two thresholds
    // that matter for this topic (25 characters): the starved notice needs
    // ~149, while one stub of a 2,000-character memory needs ~310 (the
    // block's intro, its "+N more" reserve and the stub itself). In
    // production the squeeze comes from pinned rules, which outrank the
    // floor; a small channel reaches the same shape without depending on
    // the rules renderer's own layout.
    const briefing = await runTask({
      budgetChars: 975,
      memories: [memory(0, 2_000)],
    });
    expect(briefing.length).toBeLessThanOrEqual(975);
    // The notice unique to `renderStarvedPackNotice` — silence here would
    // read as "this project has no memories", a different and false claim.
    expect(briefing).toContain('they arrive in the next messages');
    expect(briefing).not.toContain('mem_0000000000000000');
    expect(briefing).not.toContain(PACK_DROPPED);
  });

  it('holds the memory floor against heavy open loops and stays within the channel', async () => {
    // Far more loops than the channel could ever render: left unchecked they
    // spend the whole remainder, including the room the floor holds for the
    // pack. Nothing here outranks the floor (no pinned rules), so the pack
    // must still NAME its lead memory — the starved notice alone would mean
    // the loops took the floor after all.
    const briefing = await runTask({
      loops: Array.from({ length: 60 }, (_, i) => loop(900 + i, 200)),
      memories: Array.from({ length: 12 }, (_, i) => memory(i, 900)),
    });
    expect(briefing.length).toBeLessThanOrEqual(9_000);
    expect(briefing).toContain('mem_0000000000000000');
    expect(briefing).not.toContain(PACK_DROPPED);
  });

  it(
    "seats a one-memory pack's stub under heavy loops, wherever the loops stop",
    async () => {
      // A pack of one is where a floor of bare stub widths failed: the stub
      // block's own intro and "+N more" line did not fit in it, so whenever
      // the loops left the pack no more than its floor it came back starved.
      // The loops fill their budget in whole lines (~250 characters each), so
      // what they leave over the floor depends on where the last line stops;
      // sweeping one line's width of budgets lands them at every offset,
      // including the one that leaves the pack exactly its floor.
      const loops = Array.from({ length: 60 }, (_, i) => loop(900 + i, 200));
      for (let budgetChars = 8_750; budgetChars <= 9_000; budgetChars += 1) {
        const briefing = await runTask({
          budgetChars,
          loops,
          memories: [memory(0, 900)],
        });
        expect(
          briefing.length,
          `budget ${budgetChars}: briefing is ${briefing.length} chars`
        ).toBeLessThanOrEqual(budgetChars);
        expect(briefing, `budget ${budgetChars}: no stub`).toContain(
          'mem_0000000000000000'
        );
      }
    },
    SWEEP_TIMEOUT_MS
  );

  it(
    'never drops the pack wholesale, across a sweep of channel sizes',
    async () => {
      // Every section competing at once — a rule long enough to hit its
      // ceiling, loops enough to fill theirs, and sixty tiny memories whose
      // ~51-character stubs let the pack land within a character or two of
      // its own budget somewhere in a one-character sweep. That margin is
      // exactly where an unreserved composer join cost, or a pack budget that
      // forgot the task-lookup line, turns a pack that fits its own budget
      // into one the composer drops whole. Swept around the production
      // budget, where every section is present.
      const memories = Array.from({ length: 60 }, (_, i) => memory(i, 3));
      const loops = Array.from({ length: 60 }, (_, i) => loop(900 + i, 200));
      const rules = [rule(3_000)];
      for (let budgetChars = 8_800; budgetChars <= 9_000; budgetChars += 1) {
        const briefing = await runTask({ budgetChars, rules, loops, memories });
        expect(
          briefing.length,
          `budget ${budgetChars}: briefing is ${briefing.length} chars`
        ).toBeLessThanOrEqual(budgetChars);
        const hasMemorySection =
          briefing.includes('mem_0000000000000000') ||
          briefing.includes('they arrive in the next messages');
        expect(
          hasMemorySection && !briefing.includes(PACK_DROPPED),
          `budget ${budgetChars}: no stub and no starved notice`
        ).toBe(true);
      }
    },
    SWEEP_TIMEOUT_MS
  );
});

/**
 * The window's tail — what its first briefing could not fit — delivered by
 * the per-message hook itself, one memory per message, with no action from
 * the agent. Driven end to end through `runBrief`, against a real state file:
 * the queue one message leaves behind is exactly what the next one reads.
 */
describe('the briefing tail drains one memory per message', () => {
  const dirs = useStateDirs('zm-drain');
  const SESSION_ID = 'drain-session';
  /** How `planTailChunk` opens every chunk — present iff one was sent. */
  const CHUNK_FRAME = 'Continuing the session briefing';

  const seedTail = (memories: ContextMemory[]): void =>
    recordBriefTail(briefStatePath(), SESSION_ID, {
      topic: basename(dirs.work),
      memories,
      takenAt: '2026-09-23T10:00:00Z',
    });

  const tailIds = (sessionId = SESSION_ID): string[] | null =>
    readBriefTail(briefStatePath(), sessionId)?.memories.map(
      (queued) => queued.id
    ) ?? null;

  const injectedIds = (sessionId = SESSION_ID): string[] =>
    loadBriefState(briefStatePath())[sessionId]?.injected_ids ?? [];

  const serverPack = (memories: ContextMemory[]) => briefingPack({ memories });

  /** One hook invocation; returns what it put into the model's context. */
  const runHook = (
    mode: 'task' | 'session-start',
    { prompt = 'ok', sessionId = SESSION_ID } = {}
  ): Promise<string> => brief(mode, { sessionId, cwd: dirs.work, prompt });

  /** Puts the work directory on a feature branch: two topics at start. */
  const onBranch = (branch: string): void => initRepo(dirs.work, { branch });

  beforeEach(() => resolvedProject(dirs.work));

  it('empties the queue over successive short replies, and then sends no more chunks', async () => {
    const queued = [memory(711, 300), memory(712, 300)];
    seedTail(queued);

    const first = await runHook('task');
    expect(first).toContain('PROJECT: proj.usr_x.demo');
    expect(first).toContain(CHUNK_FRAME);
    expect(first).toContain(queued[0]!.id);
    expect(first).not.toContain(queued[1]!.id);
    // The stored queue shrinks by exactly the one memory sent, taken from the
    // state file alone: a short reply never calls the server.
    expect(tailIds()).toEqual([queued[1]!.id]);
    expect(callBuildContext).not.toHaveBeenCalled();
    const second = await runHook('task');
    expect(second).toContain(queued[1]!.id);
    expect(second).not.toContain(queued[0]!.id);
    // Drained to nothing, the tail is cleared rather than kept as an empty
    // queue every later message would have to read and skip.
    expect(loadBriefState(briefStatePath())[SESSION_ID]).not.toHaveProperty(
      'tail'
    );

    const third = await runHook('task');
    expect(third).toContain('PROJECT: proj.usr_x.demo');
    expect(third).not.toContain(CHUNK_FRAME);
  });

  it('drains one chunk on a substantive prompt once the task briefing has run', async () => {
    markTaskBriefed(briefStatePath(), SESSION_ID);
    const queued = [memory(721, 300), memory(722, 300)];
    seedTail(queued);

    const briefing = await runHook('task', { prompt: SUBSTANTIVE });

    expect(briefing).toContain(CHUNK_FRAME);
    expect(briefing).toContain(queued[0]!.id);
    expect(briefing).not.toContain(queued[1]!.id);
    expect(tailIds()).toEqual([queued[1]!.id]);
    expect(callBuildContext).not.toHaveBeenCalled();
  });

  it('drains one chunk on a substantive prompt whose task-briefing call fails', async () => {
    // The server is unreachable, so this message carries no pack — and the
    // tail is local, so it is exactly the message the drain can still serve.
    const queued = [memory(791, 300), memory(792, 300)];
    seedTail(queued);
    vi.mocked(callBuildContext).mockRejectedValueOnce(
      new Error('server unreachable')
    );

    const briefing = await runHook('task', { prompt: SUBSTANTIVE });

    expect(briefing).toContain('PROJECT: proj.usr_x.demo');
    expect(briefing).toContain(CHUNK_FRAME);
    expect(briefing).toContain(queued[0]!.id);
    expect(tailIds()).toEqual([queued[1]!.id]);
    // The task briefing is still owed: the next substantive message retries.
    expect(loadBriefState(briefStatePath())[SESSION_ID]?.task_briefed).toBe(
      false
    );
  });

  it('drains one chunk on a substantive prompt whose task pack is empty after dedup', async () => {
    const seen = memory(795, 300);
    recordSessionBriefing(briefStatePath(), SESSION_ID, [seen.id]);
    const queued = [memory(796, 300), memory(797, 300)];
    seedTail(queued);
    vi.mocked(callBuildContext).mockResolvedValueOnce(serverPack([seen]));

    const briefing = await runHook('task', { prompt: SUBSTANTIVE });

    expect(briefing).not.toContain('Persistent memory briefing');
    expect(briefing).toContain(CHUNK_FRAME);
    expect(briefing).toContain(queued[0]!.id);
    expect(tailIds()).toEqual([queued[1]!.id]);
    // The call succeeded, so this window's one task briefing is spent.
    expect(loadBriefState(briefStatePath())[SESSION_ID]?.task_briefed).toBe(
      true
    );
  });

  it.each(['task', 'session-start'] as const)(
    'records nothing as delivered, and loses nothing from the tail, when the composer drops the %s pack',
    async (mode) => {
      // Six long, distinct, non-pinned rules overrun their ceiling by
      // headline at these budgets, and the composer — strict priority order —
      // then drops the pack behind them whole. A dropped pack never reached
      // the window: recording its memories as delivered would hide them from
      // every later briefing of the window for good.
      const rules = Array.from({ length: 6 }, (_, i) => ({
        text: `${i} ${'r'.repeat(1_200)}`,
        pinned: false,
      }));
      const pack = [memory(801, 40), memory(802, 40), memory(803, 40)];
      const packIds: string[] = pack.map((packed) => packed.id);
      let drops = 0;
      for (let budget = 1_500; budget <= 5_500; budget += 50) {
        const sessionId = `drop-${mode}-${budget}`;
        vi.mocked(callBuildContext).mockResolvedValueOnce({
          ...serverPack(pack),
          rules,
        });
        const briefing = await withEnv(
          'ZM_BRIEF_HOOK_BUDGET_CHARS',
          String(budget),
          () => runHook(mode, { prompt: SUBSTANTIVE, sessionId })
        );
        if (!/pack did not fit this briefing's channel/.test(briefing)) {
          continue;
        }
        drops += 1;
        expect(
          injectedIds(sessionId).filter((id) => packIds.includes(id)),
          `budget ${budget}: a dropped pack was recorded as delivered`
        ).toEqual([]);
        expect(
          tailIds(sessionId),
          `budget ${budget}: a dropped pack's memories left the tail`
        ).toEqual(packIds);
      }
      // The sweep proves something only if the composer actually dropped it.
      expect(drops).toBeGreaterThan(0);
    }
  );

  it.each(['session-start', 'task'] as const)(
    'keeps the %s pack when many long non-pinned rules meet the default budget',
    async (mode) => {
      // Eight long rules nobody pinned. Admitting them whole while they fit,
      // then naming the rest by headline past the ceiling, used to overrun the
      // channel and push the whole memory pack out of the briefing.
      const rules = Array.from({ length: 8 }, (_, i) => ({
        text: `Rule ${i} ${'r'.repeat(1_300)}`,
        pinned: false,
      }));
      const lead = memory(861, 2_000);
      vi.mocked(callBuildContext).mockResolvedValueOnce({
        ...serverPack([lead]),
        rules,
      });

      const briefing = await runHook(mode, { prompt: SUBSTANTIVE });

      expect(briefing.length).toBeLessThanOrEqual(9_000);
      expect(briefing).toContain(lead.id);
    }
  );

  it('queues what neither pack delivered, and nothing either pack did, across project and branch', async () => {
    onBranch('feature/queue-both-packs');
    // A and D are too large for any pack, so each leaves by stub; B is small
    // and arrives WHOLE in the branch pack, although the project pack only
    // named it. The queue owes A and D — and never B a second time.
    const a = memory(871, 12_000);
    const b = memory(872, 300);
    const d = memory(873, 12_000);
    vi.mocked(callBuildContext)
      .mockResolvedValueOnce(serverPack([a, b]))
      .mockResolvedValueOnce(serverPack([b, d]));

    await runHook('session-start');

    expect(tailIds()).toEqual([a.id, d.id]);
    const drained = [
      await runHook('task'),
      await runHook('task'),
      await runHook('task'),
    ].join('\n');
    expect(drained).toContain(a.id);
    expect(drained).toContain(d.id);
    expect(drained).not.toContain(`"id":"${b.id}"`);
    expect(tailIds()).toBeNull();
  });

  it('merges a resumed session start into the queue it already had', async () => {
    const a = memory(881, 12_000);
    const c = memory(882, 12_000);
    seedTail([a]);
    vi.mocked(callBuildContext).mockResolvedValueOnce(serverPack([c]));

    await runHook('session-start');

    expect(tailIds()).toEqual([a.id, c.id]);
  });

  it('clears a queued memory that a resumed session start delivered whole', async () => {
    const b = memory(891, 300);
    seedTail([b]);
    vi.mocked(callBuildContext).mockResolvedValueOnce(serverPack([b]));

    const briefing = await runHook('session-start');

    expect(briefing).toContain(b.id);
    expect(tailIds()).toBeNull();
    expect(await runHook('task')).not.toContain(CHUNK_FRAME);
  });

  it('never queues on resume a memory this window already received whole', async () => {
    onBranch('feature/resume-after-delivery');
    const a = memory(901, 12_000);
    const b = memory(902, 300);
    // First start: the project pack delivers B whole.
    vi.mocked(callBuildContext)
      .mockResolvedValueOnce(serverPack([b]))
      .mockResolvedValueOnce(serverPack([]));
    await runHook('session-start');
    expect(injectedIds()).toContain(b.id);
    // Resume: only the branch pack answers, and oversized A stubs out B too.
    vi.mocked(callBuildContext)
      .mockResolvedValueOnce(serverPack([]))
      .mockResolvedValueOnce(serverPack([a, b]));

    await runHook('session-start');

    expect(tailIds()).toEqual([a.id]);
  });

  it('labels a resumed queue by what it holds, not by a queue that fully drained', async () => {
    onBranch('feature/fresh-queue-label');
    const b = memory(911, 300);
    const d = memory(912, 12_000);
    recordBriefTail(briefStatePath(), SESSION_ID, {
      topic: 'old-topic',
      memories: [b],
      takenAt: '2026-09-20T08:00:00Z',
    });
    vi.mocked(callBuildContext)
      .mockResolvedValueOnce(serverPack([b]))
      .mockResolvedValueOnce(serverPack([d]));

    await runHook('session-start');

    const tail = readBriefTail(briefStatePath(), SESSION_ID);
    expect(tail?.memories.map((queued) => queued.id)).toEqual([d.id]);
    expect(tail?.topic).not.toContain('old-topic');
    expect(tail?.takenAt).not.toBe('2026-09-20T08:00:00Z');
  });

  it('appends no chunk to the one task briefing, and settles the tail against what its pack delivered', async () => {
    // Session start: the lead memory is too large for the channel, so that
    // pack delivers nothing whole and names all four by stub — every one of
    // them becomes this window's tail, recorded by the real session-start
    // path rather than seeded.
    const oversized = memory(731, 20_000);
    const namedThenWhole = memory(732, 300);
    const namedTwice = memory(733, 300);
    const stillQueued = memory(734, 300);
    vi.mocked(callBuildContext).mockResolvedValueOnce(
      serverPack([oversized, namedThenWhole, namedTwice, stillQueued])
    );
    await runHook('session-start');
    expect(tailIds()).toEqual([
      oversized.id,
      namedThenWhole.id,
      namedTwice.id,
      stillQueued.id,
    ]);

    // The task briefing filters its pack only on memories delivered WHOLE,
    // so a memory session start merely named comes back in it. Here one of
    // them now arrives whole, beside a new one; a new oversized memory ends
    // the whole-memory run, leaving itself and the other named one over.
    const fresh = memory(735, 300);
    const freshOversized = memory(736, 20_000);
    vi.mocked(callBuildContext).mockResolvedValueOnce(
      serverPack([namedThenWhole, fresh, freshOversized, namedTwice])
    );
    const briefing = await runHook('task', { prompt: SUBSTANTIVE });

    // One memory payload per message: this message's pack carries them.
    expect(briefing).toContain('Persistent memory briefing');
    expect(briefing).not.toContain(CHUNK_FRAME);
    expect(briefing).not.toContain(oversized.id);
    // What the pack delivered whole is recorded as injected…
    expect(injectedIds()).toEqual(
      expect.arrayContaining([namedThenWhole.id, fresh.id])
    );
    // …and leaves the queue; the pack's own leftovers join it after what was
    // already queued, and the memory BOTH briefings left over is queued
    // once, where it already stood.
    expect(tailIds()).toEqual([
      oversized.id,
      namedTwice.id,
      stillQueued.id,
      freshOversized.id,
    ]);
  });

  it("starts the window's tail from the task briefing's own leftovers when it is the window's first briefing", async () => {
    // No session-start briefing landed (server down at start, say), so the
    // task briefing is the first this window gets — and its starved or
    // stubbed memories are promised to "arrive in the next messages".
    const fits = memory(741, 300);
    const oversized = memory(742, 20_000);
    const after = memory(743, 300);
    vi.mocked(callBuildContext).mockResolvedValueOnce(
      serverPack([fits, oversized, after])
    );
    await runHook('task', { prompt: SUBSTANTIVE });

    expect(injectedIds()).toEqual([fits.id]);
    expect(tailIds()).toEqual([oversized.id, after.id]);

    const next = await runHook('task');
    expect(next).toContain(CHUNK_FRAME);
    expect(next).toContain(oversized.id);
  });

  it("clears the tail when the task briefing's pack delivers all of it whole", async () => {
    const queued = [memory(745, 300), memory(746, 300)];
    seedTail(queued);
    vi.mocked(callBuildContext).mockResolvedValueOnce(serverPack(queued));

    await runHook('task', { prompt: SUBSTANTIVE });

    expect(injectedIds()).toEqual(queued.map((whole) => whole.id));
    expect(loadBriefState(briefStatePath())[SESSION_ID]).not.toHaveProperty(
      'tail'
    );
  });

  it('records a memory a chunk delivered whole as injected, so a later task briefing leaves it out', async () => {
    const drained = memory(751, 300);
    const queued = memory(752, 300);
    seedTail([drained, queued]);

    await runHook('task');
    expect(injectedIds()).toContain(drained.id);

    const fresh = memory(753, 300);
    vi.mocked(callBuildContext).mockResolvedValueOnce(
      serverPack([drained, fresh])
    );
    const briefing = await runHook('task', { prompt: SUBSTANTIVE });
    expect(briefing).toContain(fresh.id);
    expect(briefing).not.toContain(drained.id);
  });

  it('emits exactly the banner, and clears the queue, when the state file holds an empty one', async () => {
    // The hook's normal output for this session: nothing queued, banner only.
    const normal = await runHook('task', { sessionId: 'drain-baseline' });
    expect(normal).toContain('PROJECT: proj.usr_x.demo');

    seedTail([]);

    expect(await runHook('task')).toBe(normal);
    // Nothing is left for the next message to trip over: an empty queue is
    // cleared rather than read and skipped on every message.
    expect(loadBriefState(briefStatePath())[SESSION_ID]).not.toHaveProperty(
      'tail'
    );
  });

  it('sends nothing at all in an ignored project, the tail included', async () => {
    // No resolved project, so no banner: anything emitted here is the drain.
    rmSync(projectScopeStatePath(), { force: true });
    writeFileSync(join(dirs.work, '.zero-memory-ignore'), '');
    const queued = memory(771, 300);
    seedTail([queued]);

    expect(await runHook('task')).toBe('');
    expect(tailIds()).toEqual([queued.id]);
  });

  it('never lets a draining message exceed the channel, across banner and memory sizes', async () => {
    // Every banner size here leaves a different room for the chunk, and the
    // memory sizes sweep one character at a time across the point where the
    // memory stops arriving whole and falls back to a stub — the edge where a
    // chunk budgeted without the banner or the composer's join runs over. The
    // largest banner leaves too little room for even a stub.
    const seen = { whole: 0, stub: 0, held: 0 };
    let closest = 0;
    for (const padding of [0, 2_000, 6_000, 8_000, 8_350]) {
      recordProjectScope(
        projectScopeStatePath(),
        resolveProjectHint(dirs.work),
        `proj.usr_x.${'d'.repeat(padding)}`
      );
      const banner = await runHook('task', {
        sessionId: `drain-banner-${padding}`,
      });
      const room = DEFAULT_HOOK_BUDGET_CHARS - banner.length;
      const from = Math.max(1, room - 450);
      for (let content = from; content <= from + 300; content += 1) {
        const queued = memory(781, content);
        seedTail([queued]);

        const briefing = await runHook('task');

        expect(
          briefing.length,
          `banner ${banner.length}, memory ${content}: ${briefing.length} chars`
        ).toBeLessThanOrEqual(DEFAULT_HOOK_BUDGET_CHARS);
        if (!briefing.includes(CHUNK_FRAME)) {
          // Nothing is lost at the edge: a chunk that could not be sent at
          // all leaves the memory queued, untouched.
          expect(tailIds(), `memory ${content} was dropped unsent`).toEqual([
            queued.id,
          ]);
          seen.held += 1;
        } else if (briefing.includes('"content":')) {
          seen.whole += 1;
        } else {
          seen.stub += 1;
        }
        closest = Math.max(closest, briefing.length);
      }
    }
    // The sweep proves something only if it reached every outcome and came
    // right up to the edge of the channel.
    expect(seen.whole).toBeGreaterThan(0);
    expect(seen.stub).toBeGreaterThan(0);
    expect(seen.held).toBeGreaterThan(0);
    expect(closest).toBeGreaterThanOrEqual(DEFAULT_HOOK_BUDGET_CHARS - 10);
  });
});

/**
 * The session-start briefing names the branches a card holds open, and adds
 * a line when this machine's git already carries the squash of one — the
 * landing the board never heard of. `main` is a trunk branch, so the
 * briefing has one topic and exactly one server call.
 */
describe('session-start landing drift', () => {
  const dirs = useStateDirs('zm-drift');
  const CARD_ID = cardIdSchema.parse('crd_0000000000000019.0000000000');
  const WORK: BriefingWork = {
    bound_card: null,
    active: 1,
    waiting: 0,
    lead: [
      {
        id: CARD_ID,
        number: 19,
        title: 'Cards know their branches',
        state: 'active',
      },
    ],
    open_branches: [
      {
        card_id: CARD_ID,
        number: 19,
        state: 'active',
        repo: 'acme/memory-service',
        branch: 'feature/x',
      },
    ],
  };

  const briefSessionStart = (): Promise<string> => {
    vi.mocked(callBuildContext).mockResolvedValue(briefingPack({ work: WORK }));
    return brief('session-start', {
      sessionId: 'drift-session',
      cwd: dirs.work,
    });
  };

  beforeEach(() =>
    initRepo(dirs.work, {
      origin: 'git@github.com:acme/memory-service.git',
    })
  );

  it('names a landing git holds while the card still holds the branch open', async () => {
    git(
      dirs.work,
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'feat: the work',
      '-m',
      'Squashed-from: feature/x (abcdef1) ZM-19'
    );
    const text = await briefSessionStart();
    expect(text).toContain(
      'ZM-19 "Cards know their branches" [active] on feature/x'
    );
    expect(text).toContain('- ZM-19 [active]: branch feature/x landed as');
  });

  it('puts what production took under the board, and leaves the section as it was without it', async () => {
    const board = '(`board list` for the rest)';
    const quiet = await briefSessionStart();
    expect(quiet).toContain(board);
    expect(quiet).not.toContain('PRODUCTION');

    // An equally fresh machine, so the release line is the only difference.
    rmSync(dirs.state, { recursive: true, force: true });
    mkdirSync(dirs.state, { recursive: true });
    const line =
      'PRODUCTION TOOK THE CHANGES: v1.0.0 carries ZM-7; the release is recorded on each.';
    vi.mocked(checkRelease).mockResolvedValue(line);
    const told = await briefSessionStart();
    expect(told).toBe(quiet.replace(board, `${board}\n${line}`));
    expect(checkRelease).toHaveBeenLastCalledWith(dirs.work, {
      budgetMs: 3000,
    });
  });
});
