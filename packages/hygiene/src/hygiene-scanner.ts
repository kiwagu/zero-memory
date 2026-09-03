import { provenanceRank, type MemoryAuthorKind } from '@workspace/contracts';
import { createLogger } from '@workspace/logger';
import { RETRO_APERTURE_CAP, RETRO_APERTURE_FLOOR } from '@workspace/memory';
import {
  createServiceRoleClient,
  readAllPages,
  type Client,
} from '@workspace/persistence';

import {
  decideAction,
  queueInstead,
  sameSessionCollapseAction,
  type HygieneAction,
} from './hygiene-decision.js';
import {
  HygieneJudge,
  type HygieneJudgement,
  type MemorySnapshot,
} from './hygiene-judge.js';
import { crossProjectPair } from './hygiene-origin.js';
import {
  KIND_AUDIT_SUBJECT_KINDS,
  isChangeNoteCandidate,
} from './kind-audit.js';
import {
  DEFAULT_HYGIENE_CONFIG,
  type HygieneConfig,
  type HygieneVerdict,
} from './hygiene-verdict.js';

export interface HygieneScanResult {
  scanned: number;
  pairsJudged: number;
  autoResolved: number;
  queued: number;
}

/** One bounded batch of the retro pass. */
export interface RetroScanOptions {
  /** Limit the sweep to one owner; omit for the system-wide backlog. */
  ownerId?: string;
  /** How many subjects this batch walks — the run's cost control. */
  maxSubjects: number;
  /** Resume point: subjects created strictly after this ISO timestamp. */
  startAfter?: string;
  /**
   * Who judges the pairs. The default — the server-side judge, as the
   * recurring scan uses — is the product path. `false` runs NO model on the
   * server and parks every pair as `unjudged` for the session agent reading
   * the queue to adjudicate, which is how a large backlog is worked through
   * without the server paying per pair.
   */
  judge?: boolean;
}

export interface RetroScanResult extends HygieneScanResult {
  /**
   * `created_at` of the last subject walked — pass it as `startAfter` to
   * continue. Null when the corpus is exhausted.
   */
  nextCursor: string | null;
}

export interface KindAuditResult {
  /** Recent durable-kind memories examined. */
  scanned: number;
  /** Of those, change-note suspects sent to the judge. */
  flagged: number;
  /** Confirmed change notes re-kinded to `episode`. */
  rekinded: number;
}

export interface HygieneReadjudicateResult {
  /** Pending conflicts examined. */
  scanned: number;
  /** Judge calls made (stale rows are dismissed without a judge call). */
  pairsJudged: number;
  /** Conflicts the current judge no longer sees → dismissed keep_both (loss-free). */
  dismissed: number;
  /** Conflicts whose memories were already resolved/forgotten → dismissed as moot. */
  stale: number;
  /** Conflicts that still want a resolution → left pending for a human. */
  kept: number;
}

type PendingRow = {
  id: string;
  memory_a: string;
  memory_b: string;
  verdict: string;
};

type ConflictMemory = RecentMemory & {
  invalidated_at: string | null;
  owner_id: string;
};

type RecentMemory = {
  id: string;
  kind: string;
  content: string;
  scope: string;
  source: Record<string, unknown> | null;
  created_at: string;
  author_kind: string;
  agent_name: string | null;
};

type Candidate = RecentMemory & { similarity: number };

/**
 * `invalidated_by_model` marker for the deterministic same-session collapse:
 * no judge model stands behind the decision, the session identity does.
 */
const SESSION_COLLAPSE_ACTOR = 'deterministic:same-session';

/**
 * Server-side, service-role hygiene scanner (Tier-AUTO + human queue). Runs
 * independently of the (optional) Claude-Code watcher: it is triggered on the
 * server, reads across all owners' memories with the privileged client, and
 * curates each owner's own knowledge.
 *
 * For every recently-written active memory it asks the DB for near neighbours
 * (same owner), has the LLM judge classify each pair, then:
 *   - auto-resolves high-confidence duplicates/supersessions through reversible
 *     lifecycle writes (invalidate / supersede) + a supersedes link + an
 *     audit_log entry;
 *   - parks everything else (genuine contradictions, low-confidence pairs) in
 *     memory_review_queue for a human, plus a contradicts link for context.
 */
export class HygieneScanner {
  readonly #logger = createLogger('HygieneScanner');

  constructor(
    private readonly client: Client = createServiceRoleClient(),
    private readonly judge: HygieneJudge = new HygieneJudge(),
    private readonly config: HygieneConfig = DEFAULT_HYGIENE_CONFIG
  ) {}

  /**
   * Scans recent active memories for conflicts. Pass `ownerId` to scan only one
   * owner's memories (a user-triggered "find my duplicates"); omit it for the
   * system-wide sweep (cron / CLI). Pass `maxSubjects` to cap how many recent
   * memories are used as scan subjects (a limited, cheaper run) — the judge
   * cost scales with the number of subjects. Candidate lookup is same-owner
   * either way.
   */
  async scan(
    ownerId?: string,
    maxSubjects?: number
  ): Promise<HygieneScanResult> {
    const since = new Date(
      Date.now() - this.config.lookbackDays * 86_400_000
    ).toISOString();

    let query = this.client
      .from('memories')
      .select(
        // owner_id per row, not from the filter: a scheduled sweep passes no
        // filter at all and still touches many people's memories, and each
        // one's upkeep belongs to them.
        'id, kind, content, scope, source, created_at, author_kind, agent_name, owner_id'
      )
      .is('invalidated_at', null)
      .gte('created_at', since);
    if (ownerId) {
      query = query.eq('owner_id', ownerId);
    }
    query = query.order('created_at', { ascending: false });
    if (maxSubjects && maxSubjects > 0) {
      query = query.limit(maxSubjects);
    }
    const { data: recent, error } = await query;
    if (error) {
      throw new Error(
        `hygiene: loading recent memories failed: ${error.message}`
      );
    }

    return this.#walkSubjects((recent ?? []) as RecentMemory[], {
      minSimilarity: this.config.minSimilarity,
      maxCandidates: this.config.maxCandidates,
      mode: 'judge',
      queueOnly: false,
      label: 'hygiene scan complete',
    });
  }

  /**
   * Retro pass: the write path's aperture, opened WIDER and walked over
   * HISTORY instead of the recency window. Two things make it necessary
   * rather than a repeat of `scan()`. Memories older than the lookback window
   * were never subjects at all — the backlog that accumulated before the
   * pipeline existed has never been swept — and a pair the write path DID put
   * in front of a writer, who then declared nothing, needs a second reader.
   *
   * NOTHING IS RETIRED WITHOUT A PERSON, in either judging mode. The recurring
   * scan may auto-resolve a confident pair because the memory under review was
   * just written and its author is still around; a sweep of history has no
   * author present and no natural bound on how many rows one run could retire,
   * and a wrong supersede is the most expensive mistake this pipeline can
   * make. So every verdict here parks in the queue. The one thing the pass
   * settles by itself is the same-session near-verbatim collapse, which is an
   * identity rule rather than a judgement — two writes of one session at
   * near-verbatim similarity are one writer restating one fact, exactly as the
   * write path already collapses deterministically.
   *
   * WHO JUDGES is a choice (`judge`). The default is the server-side judge, as
   * everywhere else. Passing `judge: false` runs no model on the server at all
   * and parks each pair as `unjudged` for the session agent reading the queue
   * — generation stays deterministic either way, and only the judging moves.
   * That mode exists because a backlog sweep's cost is per pair over a corpus
   * that only grows, and an agent already reading the queue can adjudicate the
   * same pairs with more context and without the server paying for it.
   *
   * Bounded and resumable: a batch walks `maxSubjects` memories oldest-first
   * and returns the cursor to resume from, so the queue receives an amount a
   * reader can actually work through instead of the whole backlog at once.
   */
  async retroScan(options: RetroScanOptions): Promise<RetroScanResult> {
    let query = this.client
      .from('memories')
      // owner_id per row: see scan().
      .select(
        'id, kind, content, scope, source, created_at, author_kind, agent_name, owner_id'
      )
      .is('invalidated_at', null)
      .is('superseded_by', null);
    if (options.ownerId) {
      query = query.eq('owner_id', options.ownerId);
    }
    if (options.startAfter) {
      query = query.gt('created_at', options.startAfter);
    }
    // Oldest first: the backlog this pass exists for is at the far end of the
    // corpus, and ascending order is what makes `created_at` a usable cursor.
    const { data: subjects, error } = await query
      .order('created_at', { ascending: true })
      .limit(Math.max(1, options.maxSubjects));
    if (error) {
      throw new Error(
        `hygiene: loading retro subjects failed: ${error.message}`
      );
    }

    const page = (subjects ?? []) as RecentMemory[];
    const result = await this.#walkSubjects(page, {
      minSimilarity: RETRO_APERTURE_FLOOR,
      maxCandidates: RETRO_APERTURE_CAP,
      mode: options.judge === false ? 'offer' : 'judge',
      queueOnly: true,
      label: 'hygiene retro pass complete',
    });
    return {
      ...result,
      // Exhaustion is an EMPTY page, never a short one. A short page does not
      // mean the end: the database caps how many rows one request may return
      // (PostgREST's max-rows), so asking for more than the cap silently yields
      // the cap — and inferring "done" from that under-runs the corpus while
      // reporting success. The cost of this rule is one final empty batch; the
      // cost of the other rule was a sweep that stopped at 1000 of 2127
      // subjects and reported that it had finished.
      nextCursor: page.length === 0 ? null : (page.at(-1)?.created_at ?? null),
    };
  }

  /**
   * The pair walk shared by the recency scan and the retro pass: candidates
   * from the aperture, each pair judged at most once, provably-cross-project
   * and already-adjudicated pairs skipped, same-session refinements collapsed
   * deterministically, everything else acted on by `#apply`.
   */
  async #walkSubjects(
    subjects: RecentMemory[],
    options: {
      minSimilarity: number;
      maxCandidates: number;
      /**
       * `judge` asks the server-side judge and acts on its verdict; `offer`
       * runs no model at all and parks every pair as `unjudged` for whoever
       * reads the queue (see `retroScan`).
       */
      mode: 'judge' | 'offer';
      /** In `judge` mode, park an auto-resolution instead of applying it. */
      queueOnly: boolean;
      label: string;
    }
  ): Promise<HygieneScanResult> {
    const result: HygieneScanResult = {
      scanned: subjects.length,
      pairsJudged: 0,
      autoResolved: 0,
      queued: 0,
    };
    // Ids removed from play this run (a loser of an auto-resolution). Skipped as
    // both subject and candidate so we never re-judge or cascade off them.
    const retired = new Set<string>();
    // Canonical pair keys already judged this run — neighbours are symmetric, so
    // subject X→Y and later Y→X are the same pair; judging once halves LLM calls.
    const judgedPairs = new Set<string>();
    const pairKey = (x: string, y: string): string =>
      x < y ? `${x}|${y}` : `${y}|${x}`;

    for (const subject of subjects) {
      if (retired.has(subject.id)) {
        continue;
      }
      const { data: candidates, error: candErr } = await this.client.rpc(
        'find_review_candidates',
        {
          p_memory_id: subject.id,
          p_min_similarity: options.minSimilarity,
          p_limit: options.maxCandidates,
        }
      );
      if (candErr) {
        throw new Error(
          `hygiene: candidate lookup for ${subject.id} failed: ${candErr.message}`
        );
      }

      const enriched = await this.#attachSources(
        (candidates ?? []) as Candidate[]
      );
      const adjudicated =
        enriched.length > 0
          ? await this.#adjudicatedCounterparts(subject.id)
          : new Set<string>();
      for (const candidate of enriched) {
        if (retired.has(candidate.id)) {
          continue;
        }
        const key = pairKey(subject.id, candidate.id);
        if (judgedPairs.has(key)) {
          continue; // already judged from the other direction this run
        }
        judgedPairs.add(key);
        if (adjudicated.has(candidate.id)) {
          // The pair reached the queue once already (pending, or settled by a
          // human/agent) — never re-judge it: repeat judging wastes tokens
          // and could overturn a deliberate keep_both with a later
          // high-confidence auto-supersede.
          this.#logger.debug('pair skipped: already adjudicated', {
            subject: subject.id,
            candidate: candidate.id,
          });
          continue;
        }
        if (crossProjectPair(subject, candidate)) {
          continue; // provably different projects — not a conflict, no judge
        }
        // Same-session refinement (deterministic, no judge): the write-time
        // collapse already handles most of these, but a pair the scan sees
        // first (e.g. the first refinement of a burst) resolves here.
        const collapsed = await this.#collapseSameSessionPair(
          subject,
          candidate
        );
        if (collapsed !== null) {
          result.autoResolved += 1;
          retired.add(collapsed);
          if (collapsed === subject.id) {
            break; // the subject itself lost; stop judging its neighbours
          }
          continue;
        }
        if (options.mode === 'offer') {
          // No model runs here: the pair is parked with no opinion attached
          // and the reader of the queue is the judge.
          await this.#offer(subject, candidate);
          result.queued += 1;
          continue;
        }
        // The pair is judged for whoever owns the memory under review — a
        // scheduled sweep has no filter to fall back on.
        const subjectOwner = (subject as { owner_id?: string }).owner_id;
        const judgement = await this.judge.judge(
          snapshot(subject),
          snapshot(candidate),
          subjectOwner
        );
        result.pairsJudged += 1;
        await this.#meterJudge(judgement, subjectOwner);
        const verdict = judgement.verdict;
        const loser = await this.#apply(
          subject,
          candidate,
          verdict,
          judgement.model,
          options.queueOnly
        );
        if (loser === null) {
          continue;
        }
        if (loser === 'queued') {
          result.queued += 1;
          continue;
        }
        result.autoResolved += 1;
        retired.add(loser);
        if (loser === subject.id) {
          break; // the subject itself lost; stop judging its neighbours
        }
      }
    }

    this.#logger.info(options.label, { ...result });
    return result;
  }
  /**
   * Kind audit: demote changelog-style change notes out of durable kinds.
   * Durable kinds (decision/convention/preference) carry ranking weight 1.0
   * and a years-long half-life, so a mis-kinded "Updated X…" note pollutes
   * the top of recall forever. Two stages keep it safe and cheap: the free
   * deterministic prefilter picks suspects, the LLM judge confirms each, and
   * only a confident change-note verdict re-kinds the memory to `episode`
   * (reversible — the audit log keeps the previous kind; content untouched).
   */
  async auditKinds(
    ownerId?: string,
    maxSubjects?: number
  ): Promise<KindAuditResult> {
    const since = new Date(
      Date.now() - this.config.lookbackDays * 86_400_000
    ).toISOString();

    let query = this.client
      .from('memories')
      // owner_id per row: see scan().
      .select('id, kind, content, created_at, owner_id')
      .is('invalidated_at', null)
      .in('kind', [...KIND_AUDIT_SUBJECT_KINDS])
      .gte('created_at', since);
    if (ownerId) {
      query = query.eq('owner_id', ownerId);
    }
    query = query.order('created_at', { ascending: false });
    if (maxSubjects && maxSubjects > 0) {
      query = query.limit(maxSubjects);
    }
    const { data: subjects, error } = await query;
    if (error) {
      throw new Error(
        `hygiene: loading kind-audit subjects failed: ${error.message}`
      );
    }

    const result: KindAuditResult = {
      scanned: subjects?.length ?? 0,
      flagged: 0,
      rekinded: 0,
    };

    for (const subject of subjects ?? []) {
      if (!isChangeNoteCandidate(subject.content)) {
        continue;
      }
      result.flagged += 1;
      const subjectOwner = (subject as { owner_id?: string }).owner_id;
      const judgement = await this.judge.judgeKind(
        {
          id: subject.id,
          kind: subject.kind,
          content: subject.content,
        },
        subjectOwner
      );
      await this.#meterJudge(judgement, subjectOwner);
      if (
        !judgement.verdict.change_note ||
        judgement.verdict.confidence < this.config.rekindConfidence
      ) {
        continue;
      }
      const { error: rekindError } = await this.client
        .from('memories')
        .update({ kind: 'episode' })
        .eq('id', subject.id);
      if (rekindError) {
        throw new Error(
          `hygiene: rekind ${subject.id} failed: ${rekindError.message}`
        );
      }
      await this.#audit('hygiene.rekind', {
        memory_id: subject.id,
        from_kind: subject.kind,
        to_kind: 'episode',
        confidence: judgement.verdict.confidence,
        model: judgement.model,
      });
      result.rekinded += 1;
    }

    this.#logger.info('hygiene kind audit complete', { ...result });
    return result;
  }

  /**
   * Scans ONE memory (write-triggered path): judge it against its same-owner
   * neighbours and auto-resolve / queue. Used to reconcile a freshly-written
   * memory before the next recall, without a full sweep. Cheap: one subject,
   * a few candidates.
   */
  async scanOne(memoryId: string): Promise<HygieneScanResult> {
    const result: HygieneScanResult = {
      scanned: 0,
      pairsJudged: 0,
      autoResolved: 0,
      queued: 0,
    };

    const { data: subject, error } = await this.client
      .from('memories')
      .select(
        // owner_id comes along so the judge runs on this memory owner's key
        // and against their allowance: upkeep of someone's corpus is work
        // done for them, not for the instance.
        'id, kind, content, scope, source, created_at, author_kind, agent_name, owner_id'
      )
      .eq('id', memoryId)
      .is('invalidated_at', null)
      .maybeSingle();
    if (error || !subject) {
      return result;
    }
    result.scanned = 1;

    const { data: candidates, error: candErr } = await this.client.rpc(
      'find_review_candidates',
      {
        p_memory_id: subject.id,
        p_min_similarity: this.config.minSimilarity,
        p_limit: this.config.maxCandidates,
      }
    );
    if (candErr) {
      throw new Error(
        `hygiene: candidate lookup for ${subject.id} failed: ${candErr.message}`
      );
    }

    const enriched = await this.#attachSources(
      (candidates ?? []) as Candidate[]
    );
    const adjudicated =
      enriched.length > 0
        ? await this.#adjudicatedCounterparts(subject.id)
        : new Set<string>();
    for (const candidate of enriched) {
      if (adjudicated.has(candidate.id)) {
        // Already reached the queue once — settled or pending; never re-judge.
        this.#logger.debug('pair skipped: already adjudicated', {
          subject: subject.id,
          candidate: candidate.id,
        });
        continue;
      }
      if (crossProjectPair(subject as RecentMemory, candidate)) {
        continue; // provably different projects — not a conflict, no judge
      }
      // Same-session refinement (deterministic, no judge) — see scan().
      const collapsed = await this.#collapseSameSessionPair(
        subject as RecentMemory,
        candidate
      );
      if (collapsed !== null) {
        result.autoResolved += 1;
        if (collapsed === subject.id) {
          break; // the subject itself lost; nothing more to compare
        }
        continue;
      }
      const judgement = await this.judge.judge(
        snapshot(subject as RecentMemory),
        snapshot(candidate),
        (subject as { owner_id?: string }).owner_id
      );
      result.pairsJudged += 1;
      await this.#meterJudge(
        judgement,
        (subject as { owner_id?: string }).owner_id
      );
      const loser = await this.#apply(
        subject as RecentMemory,
        candidate,
        judgement.verdict,
        judgement.model
      );
      if (loser === 'queued') {
        result.queued += 1;
      } else if (loser !== null) {
        result.autoResolved += 1;
        if (loser === subject.id) {
          break; // the subject itself lost; nothing more to compare
        }
      }
    }

    this.#logger.info('hygiene scanOne complete', { memoryId, ...result });
    return result;
  }

  /**
   * Self-healing pass over the human review queue. Two jobs, gated by `rejudge`
   * so the cheap one can run continuously and the paid one only on demand:
   *
   *   - **stale sweep (always, no LLM):** a pending pair with a side already
   *     invalidated/forgotten elsewhere (a declared supersede, a merge, another
   *     auto-resolution) is moot — dismiss it as keep_both. Same no-LLM class: a
   *     pair whose sides provably belong to DIFFERENT projects (see
   *     `crossProjectPair`) is not a conflict and is dismissed too. Free (DB
   *     checks), so the nightly scheduler runs this every tick.
   *   - **re-judge (`rejudge: true`, costs judge calls):** re-classify each
   *     still-live pending pair with the CURRENT judge and dismiss (keep_both)
   *     the ones that no longer look like a conflict — this clears the backlog a
   *     weaker judge left behind after the judge is improved (e.g. false
   *     `supersedes` on complementary authoritative pairs the `complementary`
   *     verdict now keeps-both). Only worth paying for right AFTER a judge/
   *     prompt/model change, so it is on-demand (manual scan button, CLI), NOT
   *     on every nightly tick — a stable judge would just re-confirm the same
   *     verdicts and burn tokens.
   *
   * In every case it is conservative and loss-free: it ONLY dismisses as
   * keep_both (both memories stay live) or leaves the row for a human. It never
   * auto-applies a supersede/forget a person did not approve.
   *
   * Pass `ownerId` to re-adjudicate only one owner's queue (the interactive
   * scan path); omit it for the system-wide sweep.
   */
  async readjudicatePending(
    opts: { ownerId?: string; maxRows?: number; rejudge?: boolean } = {}
  ): Promise<HygieneReadjudicateResult> {
    const { ownerId, maxRows, rejudge = true } = opts;
    const result: HygieneReadjudicateResult = {
      scanned: 0,
      pairsJudged: 0,
      dismissed: 0,
      stale: 0,
      kept: 0,
    };

    // Paged when unbounded: without an explicit maxRows this walks the WHOLE
    // pending queue, and a capped read would leave the tail unexamined while
    // the result counts read as a complete pass.
    const rows =
      maxRows && maxRows > 0
        ? (
            await this.client
              .from('memory_review_queue')
              .select('id, memory_a, memory_b, verdict')
              .eq('status', 'pending')
              .order('created_at', { ascending: true })
              .limit(maxRows)
          ).data
        : await readAllPages(
            (from, to) =>
              this.client
                .from('memory_review_queue')
                .select('id, memory_a, memory_b, verdict')
                .eq('status', 'pending')
                .order('created_at', { ascending: true })
                .range(from, to),
            { label: 'hygiene: loading pending queue' }
          );

    for (const row of (rows ?? []) as PendingRow[]) {
      const { data: mems, error: memErr } = await this.client
        .from('memories')
        .select(
          'id, kind, content, scope, source, created_at, author_kind, agent_name, invalidated_at, owner_id'
        )
        .in('id', [row.memory_a, row.memory_b]);
      if (memErr) {
        throw new Error(
          `hygiene: readjudicate memory lookup failed: ${memErr.message}`
        );
      }
      const loaded = (mems ?? []) as ConflictMemory[];
      const a = loaded.find((m) => m.id === row.memory_a);
      const b = loaded.find((m) => m.id === row.memory_b);

      // Owner scope: only touch this owner's conflicts when asked.
      if (ownerId && (a?.owner_id !== ownerId || b?.owner_id !== ownerId)) {
        continue;
      }
      result.scanned += 1;

      // A side already resolved/forgotten elsewhere → the conflict is moot.
      // This is the free (no-LLM) job and runs regardless of `rejudge`.
      if (!a || !b || a.invalidated_at !== null || b.invalidated_at !== null) {
        await this.#dismissKeepBoth(
          row.id,
          a?.owner_id ?? b?.owner_id ?? null,
          'stale'
        );
        result.stale += 1;
        continue;
      }

      // Provably different projects (provenance-derived) → not a conflict.
      // Also free (no LLM), so it runs on every tick like the stale sweep and
      // clears cross-project rows an older scanner queued before the filter.
      if (crossProjectPair(a, b)) {
        await this.#dismissKeepBoth(row.id, a.owner_id, 'cross_project');
        result.dismissed += 1;
        continue;
      }

      // Live pair: only the paid re-judge touches it. Without `rejudge` we leave
      // it for a human (the nightly stale-sweep does no judge calls).
      if (!rejudge) {
        result.kept += 1;
        continue;
      }

      // An `unjudged` row has no judgement to RE-adjudicate: it was parked for
      // the reader on purpose, and paying the server judge for it here would
      // quietly undo that choice. The free sweeps above still apply to it.
      if (row.verdict === 'unjudged') {
        result.kept += 1;
        continue;
      }

      // The queued pair already carries its owner (used just above for the
      // cross-project dismissal), so attribution comes from the row.
      const judgement = await this.judge.judge(
        snapshot(a),
        snapshot(b),
        a.owner_id
      );
      result.pairsJudged += 1;
      await this.#meterJudge(judgement, a.owner_id);

      const action = decideAction(
        judgement.verdict,
        {
          subjectId: a.id,
          candidateId: b.id,
          subjectNewer: a.created_at >= b.created_at,
          subjectRank: provenanceRank(
            a.author_kind as MemoryAuthorKind,
            a.agent_name
          ),
          candidateRank: provenanceRank(
            b.author_kind as MemoryAuthorKind,
            b.agent_name
          ),
          subjectKind: a.kind,
          candidateKind: b.kind,
        },
        {
          autoConfidence: this.config.autoConfidence,
          autoInvalidateConfidence: this.config.autoInvalidateConfidence,
        }
      );

      // Loss-free self-heal: dismiss ONLY when the current judge no longer sees
      // a conflict (complementary/unrelated → skip). Everything else stays for a
      // human — re-adjudication never mutates memories on its own.
      if (action.kind === 'skip') {
        await this.#dismissKeepBoth(
          row.id,
          a.owner_id,
          judgement.verdict.relation
        );
        result.dismissed += 1;
      } else {
        result.kept += 1;
      }
    }

    this.#logger.info('hygiene readjudicate complete', { ...result });
    return result;
  }

  /**
   * Dismiss a pending conflict as keep_both (loss-free): both memories stay
   * live, the queue row is closed and the reason recorded in the audit log.
   */
  async #dismissKeepBoth(
    queueId: string,
    ownerId: string | null,
    reason: string
  ): Promise<void> {
    const { error } = await this.client
      .from('memory_review_queue')
      .update({
        status: 'dismissed',
        resolution: 'keep_both',
        winner: null,
        resolved_by: ownerId,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', queueId)
      .eq('status', 'pending');
    if (error) {
      throw new Error(`hygiene: dismiss ${queueId} failed: ${error.message}`);
    }
    await this.#audit('HygieneReadjudicateKeepBoth', {
      queue: queueId,
      reason,
    });
  }

  /**
   * Deterministic same-session refinement collapse for a candidate pair the
   * scan reached before (or despite) the write-time collapse: both sides
   * authoritative, same stamped `ses_` session, cosine at or above the dedup
   * band — the newest side supersedes the older one with NO judge call.
   * Returns the retired (loser) memory id, or null when the rule does not
   * apply. Reversible, audited, attributed to the deterministic rule instead
   * of a judge model.
   */
  async #collapseSameSessionPair(
    subject: RecentMemory,
    candidate: Candidate
  ): Promise<string | null> {
    const action = sameSessionCollapseAction(
      {
        id: subject.id,
        rank: provenanceRank(
          subject.author_kind as MemoryAuthorKind,
          subject.agent_name
        ),
        source: subject.source,
      },
      {
        id: candidate.id,
        rank: provenanceRank(
          candidate.author_kind as MemoryAuthorKind,
          candidate.agent_name
        ),
        source: candidate.source,
      },
      candidate.similarity,
      subject.created_at >= candidate.created_at
    );
    if (action === null) {
      return null;
    }
    await this.#supersede(action.loser, action.winner, SESSION_COLLAPSE_ACTOR);
    await this.#link(action.winner, action.loser, 'supersedes');
    await this.#audit('HygieneSameSessionCollapse', {
      winner: action.winner,
      loser: action.loser,
    });
    this.#logger.info('same-session refinement collapsed', { ...action });
    return action.loser;
  }

  /**
   * Applies one verdict. Returns the retired memory id on an auto-resolution,
   * the literal `'queued'` when parked for a human, or null when nothing to do.
   */
  async #apply(
    subject: RecentMemory,
    candidate: Candidate,
    verdict: HygieneVerdict,
    // Judge model behind this decision — recorded on the invalidated loser as
    // the invalidation actor's model, for auto-resolution success analysis.
    model: string,
    // Park an auto-resolution instead of applying it (the sweep over history).
    queueOnly = false
  ): Promise<string | 'queued' | null> {
    const decided = decideAction(
      verdict,
      {
        subjectId: subject.id,
        candidateId: candidate.id,
        subjectNewer: subject.created_at >= candidate.created_at,
        subjectRank: provenanceRank(
          subject.author_kind as MemoryAuthorKind,
          subject.agent_name
        ),
        candidateRank: provenanceRank(
          candidate.author_kind as MemoryAuthorKind,
          candidate.agent_name
        ),
        subjectKind: subject.kind,
        candidateKind: candidate.kind,
      },
      {
        autoConfidence: this.config.autoConfidence,
        autoInvalidateConfidence: this.config.autoInvalidateConfidence,
      }
    );
    const action = queueOnly ? queueInstead(decided) : decided;
    const audit = {
      confidence: verdict.confidence,
      rationale: verdict.rationale,
    };

    switch (action.kind) {
      case 'skip':
        // A confident complementary pair is durable graph signal: both stay
        // live, related facets of one subject. Low-confidence ones are NOT
        // linked — the complementary verdict is known to drift toward
        // genuinely-unrelated pairs, and a noise link pollutes the graph.
        if (
          verdict.relation === 'complementary' &&
          verdict.confidence >= this.config.autoConfidence
        ) {
          await this.#link(subject.id, candidate.id, 'relates_to');
        }
        return null;

      case 'forget':
        await this.#forget(action.loser, model);
        await this.#link(action.winner, action.loser, 'supersedes');
        await this.#audit('HygieneAutoDuplicate', {
          winner: action.winner,
          loser: action.loser,
          ...audit,
        });
        return action.loser;

      case 'supersede':
        await this.#supersede(action.loser, action.winner, model);
        await this.#link(action.winner, action.loser, 'supersedes');
        await this.#audit('HygieneAutoSupersede', {
          winner: action.winner,
          loser: action.loser,
          ...audit,
        });
        return action.loser;

      case 'queue':
        await this.#enqueue(subject, candidate, action, verdict);
        // A real contradiction also gets a contradicts link for context.
        if (action.contradiction) {
          await this.#link(subject.id, candidate.id, 'contradicts');
        }
        return 'queued';
    }
  }

  /**
   * Counterpart ids of every review-queue row involving this memory — pending
   * or settled. A pair that reached the queue once was ADJUDICATED: it is
   * either awaiting a human or was already decided (auto, agent triage, or a
   * person). The sweep must not judge such a pair again — repeat judging
   * spends tokens nightly on the same neighbours and, worse, lets a
   * nondeterministic judge overturn a deliberate keep_both with a later
   * high-confidence auto-supersede.
   */
  async #adjudicatedCounterparts(memoryId: string): Promise<Set<string>> {
    const { data, error } = await this.client
      .from('memory_review_queue')
      .select('memory_a, memory_b')
      .or(`memory_a.eq.${memoryId},memory_b.eq.${memoryId}`);
    if (error) {
      throw new Error(
        `hygiene: adjudicated-pair lookup for ${memoryId} failed: ` +
          error.message
      );
    }
    return new Set(
      (data ?? [])
        .map((row) => (row.memory_a === memoryId ? row.memory_b : row.memory_a))
        // Single-subject disputes (memory_b null) have no counterpart.
        .filter((id): id is string => id !== null)
    );
  }

  /**
   * `find_review_candidates` carries no `source`; fetch it in one batch so the
   * cross-project filter can see import provenance on the candidate side.
   */
  async #attachSources(candidates: Candidate[]): Promise<Candidate[]> {
    if (candidates.length === 0) {
      return candidates;
    }
    const { data, error } = await this.client
      .from('memories')
      .select('id, source')
      .in(
        'id',
        candidates.map((candidate) => candidate.id)
      );
    if (error) {
      throw new Error(
        `hygiene: candidate source lookup failed: ${error.message}`
      );
    }
    const byId = new Map(
      (data ?? []).map((memory) => [memory.id, memory.source])
    );
    return candidates.map((candidate) => ({
      ...candidate,
      source: (byId.get(candidate.id) ?? null) as Record<
        string,
        unknown
      > | null,
    }));
  }

  /** Meter one judge call's tokens (best-effort, service-role, actor-less). */
  async #meterJudge(
    judgement: Pick<
      HygieneJudgement,
      'model' | 'inputTokens' | 'outputTokens' | 'ranOnCallerKey'
    >,
    ownerId?: string
  ): Promise<void> {
    const { error } = await this.client.from('usage_events').insert({
      event_type: 'llm_extraction',
      // Whose work this is: upkeep of a corpus is done for its owner, so
      // it lands on their ledger and their allowance, not the instance's.
      user_id: ownerId ?? null,
      quantity: judgement.inputTokens + judgement.outputTokens,
      unit: 'tokens',
      agent_name: 'hygiene-scanner',
      metadata: {
        purpose: 'hygiene_judge',
        model: judgement.model,
        input_tokens: judgement.inputTokens,
        output_tokens: judgement.outputTokens,
        ...(judgement.ranOnCallerKey ? { own_key: true } : {}),
      },
    });
    if (error) {
      this.#logger.warn('hygiene: judge metering failed', {
        error: error.message,
      });
    }
  }

  async #forget(memoryId: string, model: string): Promise<void> {
    // System invalidation: no usr_ actor, so attribute the scanner + judge
    // model instead of invalidated_by (see the memories column comments).
    const { error } = await this.client
      .from('memories')
      .update({
        invalidated_at: new Date().toISOString(),
        invalidated_by_agent: 'hygiene-scanner',
        invalidated_by_model: model,
      })
      .eq('id', memoryId);
    if (error) {
      throw new Error(`hygiene: forget ${memoryId} failed: ${error.message}`);
    }
  }

  async #supersede(
    loserId: string,
    winnerId: string,
    model: string
  ): Promise<void> {
    // Reversible: superseded_by records the replacement, invalidated_at drops
    // the loser out of recall (search excludes invalidated rows). Attributed to
    // the scanner + judge model — a system invalidation has no usr_ actor.
    const { error } = await this.client
      .from('memories')
      .update({
        superseded_by: winnerId,
        invalidated_at: new Date().toISOString(),
        invalidated_by_agent: 'hygiene-scanner',
        invalidated_by_model: model,
      })
      .eq('id', loserId);
    if (error) {
      throw new Error(
        `hygiene: supersede ${loserId} by ${winnerId} failed: ${error.message}`
      );
    }
  }

  async #link(
    src: string,
    dst: string,
    type: 'supersedes' | 'contradicts' | 'relates_to'
  ): Promise<void> {
    const { error } = await this.client
      .from('memory_links')
      .upsert(
        { src, dst, type },
        { onConflict: 'src,dst,type', ignoreDuplicates: true }
      );
    if (error) {
      throw new Error(
        `hygiene: link ${src}->${dst} (${type}) failed: ${error.message}`
      );
    }
  }

  async #audit(
    command: string,
    payload: Record<string, string | number>
  ): Promise<void> {
    const { error } = await this.client.from('audit_log').insert({
      command,
      payload,
      outcome: 'ok',
      author_kind: 'agent',
      agent_name: 'hygiene-scanner',
    });
    if (error) {
      // Audit is best-effort context, not the operation itself: log and move on.
      this.#logger.warn('hygiene: audit write failed', {
        command,
        error: error.message,
      });
    }
  }

  /**
   * Parks a pair the retro aperture found, with no opinion attached: verdict
   * `unjudged`, no winner, and null confidence/rationale, because no judgement
   * was made and pretending otherwise would mislead the reader. Idempotent —
   * the unique pair key means a pair already in the queue (from any producer)
   * is left exactly as it is.
   */
  async #offer(subject: RecentMemory, candidate: Candidate): Promise<void> {
    // Canonical pair order (memory_a < memory_b), as in #enqueue.
    const [memoryA, memoryB] =
      subject.id < candidate.id
        ? [subject.id, candidate.id]
        : [candidate.id, subject.id];

    const { error } = await this.client.from('memory_review_queue').upsert(
      {
        memory_a: memoryA,
        memory_b: memoryB,
        similarity: candidate.similarity,
        verdict: 'unjudged',
        winner: null,
        confidence: null,
        rationale: null,
      },
      { onConflict: 'memory_a,memory_b', ignoreDuplicates: true }
    );
    if (error) {
      throw new Error(
        `hygiene: offer ${subject.id}/${candidate.id} failed: ${error.message}`
      );
    }
  }

  async #enqueue(
    subject: RecentMemory,
    candidate: Candidate,
    action: Extract<HygieneAction, { kind: 'queue' }>,
    verdict: HygieneVerdict
  ): Promise<void> {
    // Canonical pair order (memory_a < memory_b) so the unordered pair is
    // unique; the proposed supersede direction rides in `winner`.
    const [memoryA, memoryB] =
      subject.id < candidate.id
        ? [subject.id, candidate.id]
        : [candidate.id, subject.id];

    const { error } = await this.client.from('memory_review_queue').upsert(
      {
        memory_a: memoryA,
        memory_b: memoryB,
        similarity: candidate.similarity,
        verdict: action.verdict,
        winner: action.winner,
        confidence: verdict.confidence,
        rationale: verdict.rationale,
      },
      { onConflict: 'memory_a,memory_b', ignoreDuplicates: true }
    );
    if (error) {
      throw new Error(
        `hygiene: enqueue ${subject.id}/${candidate.id} failed: ${error.message}`
      );
    }
  }
}

const snapshot = (memory: RecentMemory): MemorySnapshot => ({
  id: memory.id,
  kind: memory.kind,
  content: memory.content,
});
