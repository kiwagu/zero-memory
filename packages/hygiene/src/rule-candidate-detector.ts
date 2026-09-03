import { createLogger } from '@workspace/logger';
import {
  createServiceRoleClient,
  readAllPages,
  type Client,
} from '@workspace/persistence';

import {
  DEFAULT_INCUBATOR_CONFIG,
  mergeScopeSuggestions,
  targetLayerForScope,
  type IncubatorConfig,
  type RuleDistillation,
  type RuleTargetLayer,
} from './rule-candidate.js';
import {
  RuleDistiller,
  type NeighborSnapshot,
  type RuleDistillerJudgement,
  type ScopeInventoryEntry,
} from './rule-distiller.js';

export interface RuleCandidateScanResult {
  /** Qualifying memories the rollup returned. */
  detected: number;
  /** New candidate rows inserted (rollup minus already-known memories). */
  queued: number;
  /** Of the new rows, drafts that cleared the distiller gate. */
  distilled: number;
  /** Of the new rows, low-confidence / not-a-rule auto-dismissals. */
  autoDismissed: number;
  /** Expired snoozes flipped back to pending. */
  unsnoozed: number;
}

/** One row of the find_rule_candidates rollup. */
type RollupRow = {
  memory_id: string;
  owner_id: string;
  kind: string;
  scope: string;
  content: string;
  useful_sessions: number;
  first_used_at: string | null;
  last_used_at: string | null;
  session_keys: string[] | null;
};

type LinkRow = { src: string; dst: string };

const AGENT_NAME = 'rule-incubator';

/** Inventory bounds: enough scopes/samples to judge applicability, cheaply. */
const MAX_INVENTORY_SCOPES = 12;
const SAMPLES_PER_SCOPE = 3;
const SAMPLE_CHARS = 120;

/**
 * Should this distillation reach the human queue? Conservative on purpose:
 * the incubator's worth is measured by how few false candidates the owner
 * sees, so doubt dismisses. Exported pure for tests.
 */
export const clearsDistillGate = (
  verdict: RuleDistillation,
  minConfidence: number
): boolean => verdict.rule && verdict.confidence >= minConfidence;

/**
 * Server-side, service-role rules-incubator detector. Runs alongside the
 * hygiene scanner (same triggers: scheduler tick, scan_hygiene, dashboard
 * scan): re-pends expired snoozes, asks the DB rollup for memories that
 * earned candidacy, inserts one row per new candidate, then distills each
 * new row into an imperative rule draft — or auto-dismisses it when the
 * distiller is unconvinced. Every outcome is audited; approval itself is
 * always a human action in the dashboard.
 */
export class RuleCandidateDetector {
  readonly #logger = createLogger('RuleCandidateDetector');

  constructor(
    private readonly client: Client = createServiceRoleClient(),
    private readonly distiller: RuleDistiller = new RuleDistiller(),
    private readonly config: IncubatorConfig = DEFAULT_INCUBATOR_CONFIG
  ) {}

  /**
   * One detection run. Pass `ownerId` to detect only one owner's candidates
   * (the user-triggered scan); omit it for the system-wide sweep. Pass
   * `maxCandidates` to cap distiller spend on a single run.
   */
  async detect(
    ownerId?: string,
    maxCandidates?: number
  ): Promise<RuleCandidateScanResult> {
    const result: RuleCandidateScanResult = {
      detected: 0,
      queued: 0,
      distilled: 0,
      autoDismissed: 0,
      unsnoozed: 0,
    };

    result.unsnoozed = await this.#unsnoozeExpired();

    const { data: rollup, error } = await this.client.rpc(
      'find_rule_candidates',
      {
        p_owner: ownerId ?? undefined,
        p_window_days: this.config.windowDays,
        p_min_sessions: this.config.minSessions,
        p_stability_days: this.config.stabilityDays,
      }
    );
    if (error) {
      throw new Error(`incubator: candidate rollup failed: ${error.message}`);
    }

    let rows = (rollup ?? []) as RollupRow[];
    result.detected = rows.length;
    if (maxCandidates && maxCandidates > 0) {
      rows = rows.slice(0, maxCandidates);
    }

    // Scope inventories are per owner and stable within one run; cache them
    // so a system-wide sweep loads each owner's inventory once.
    const inventories = new Map<string, ScopeInventoryEntry[]>();

    for (const row of rows) {
      const inserted = await this.#insertCandidate(row);
      if (!inserted) {
        continue; // raced with another run — that run owns the distillation
      }
      result.queued += 1;

      const neighbors = await this.#loadNeighbors(row);
      let inventory = inventories.get(row.owner_id);
      if (!inventory) {
        inventory = await this.#loadScopeInventory(row.owner_id);
        inventories.set(row.owner_id, inventory);
      }
      const judgement = await this.distiller.distill(
        {
          id: row.memory_id,
          kind: row.kind,
          scope: row.scope,
          content: row.content,
        },
        neighbors,
        // The rule's own scope is not a suggestion target.
        inventory.filter((entry) => entry.scope !== row.scope),
        // Per row: the same owner whose scope inventory was just loaded.
        row.owner_id
      );
      await this.#meterDistill(judgement, row.owner_id);

      if (clearsDistillGate(judgement.verdict, this.config.distillConfidence)) {
        await this.#saveDraft(inserted, row, judgement, inventory);
        result.distilled += 1;
      } else {
        await this.#autoDismiss(inserted, row.memory_id, judgement);
        result.autoDismissed += 1;
      }
    }

    this.#logger.info('incubator detection complete', { ...result });
    return result;
  }

  /**
   * On-demand promotion: turn ONE memory into a promoted rule right now,
   * bypassing the earned-usefulness path. For the case the owner already
   * knows a memory is a standing rule and does not want to wait for it to
   * accumulate cross-session usefulness (or resort to a DB seed).
   *
   * Service-role (like `detect`), so it verifies ownership itself: the memory
   * must belong to `ownerId`. The imperative rule text is distilled from the
   * memory (same distiller as the incubator) unless the caller supplies one;
   * the distiller's `rule=false`/low-confidence verdict does NOT block — the
   * owner's promotion is authoritative — it only shapes the text and the
   * scope suggestions. Idempotent-ish via unique(memory_id): an existing
   * candidacy (pending/dismissed/promoted) is flipped to promoted with the
   * new addressing.
   */
  async promoteOnDemand(params: {
    memoryId: string;
    ownerId: string;
    appliesScope?: string;
    ruleText?: string;
    force?: boolean;
  }): Promise<{
    memory_id: string;
    rule_text: string;
    target_layer: RuleTargetLayer;
    applies_scope: string | null;
    status: 'promoted';
  }> {
    const { memoryId, ownerId, appliesScope, ruleText, force } = params;

    const { data: memory, error: memErr } = await this.client
      .from('memories')
      .select('id, kind, scope, content, owner_id, invalidated_at')
      .eq('id', memoryId)
      .maybeSingle();
    if (memErr) {
      throw new Error(`promote_rule: memory lookup failed: ${memErr.message}`);
    }
    if (!memory || memory.owner_id !== ownerId) {
      throw new Error('promote_rule: memory not found or not owned by you.');
    }
    if (memory.invalidated_at !== null) {
      throw new Error('promote_rule: cannot promote an invalidated memory.');
    }

    // Guard the upsert: reviving a DELIBERATELY dismissed candidacy needs an
    // explicit override, so a routine promote never silently overturns the
    // owner's earlier "not a rule" decision.
    if (!force) {
      const { data: existing } = await this.client
        .from('rule_candidates')
        .select('status')
        .eq('memory_id', memoryId)
        .maybeSingle();
      if (existing?.status === 'dismissed') {
        throw new Error(
          'promote_rule: this memory was deliberately dismissed as a rule; ' +
            'pass force to promote it anyway.'
        );
      }
    }

    const scope = memory.scope as unknown as string;
    // Distill for clean imperative text + scope suggestions unless the caller
    // supplied the text. The verdict never gates the promotion here.
    let text = ruleText?.trim() ?? '';
    let suggestions: RuleDistillation['scope_suggestions'] = [];
    let confidence: number | null = null;
    let rationale: string | null = null;
    let model: string | null = null;
    if (!text) {
      const judgement = await this.distiller.distill(
        {
          id: memory.id,
          kind: memory.kind,
          scope,
          content: memory.content,
        },
        [],
        [],
        ownerId
      );
      // Same as the incubator detect() path: the on-demand distill LLM call
      // spends tokens on the owner's behalf, so it must land on their ledger.
      await this.#meterDistill(judgement, ownerId);
      text = judgement.verdict.rule_text.trim();
      suggestions = judgement.verdict.scope_suggestions ?? [];
      confidence = judgement.verdict.confidence;
      rationale = judgement.verdict.rationale;
      model = judgement.model;
    }
    // Fall back to the memory itself when the distiller returned nothing.
    if (!text) {
      text = memory.content.trim();
    }

    const targetLayer: RuleTargetLayer = appliesScope
      ? 'project'
      : targetLayerForScope(scope);
    const suggestedScopes = mergeScopeSuggestions(scope, suggestions, []);
    const now = new Date().toISOString();

    const { error: upErr } = await this.client.from('rule_candidates').upsert(
      {
        memory_id: memoryId,
        useful_sessions: 0,
        window_days: 0,
        rule_text: text,
        target_layer: targetLayer,
        applies_scope: appliesScope ?? null,
        suggested_scopes: suggestedScopes,
        judge_confidence: confidence,
        judge_rationale: rationale,
        judge_model: model,
        status: 'promoted',
        resolution: 'promoted',
        resolved_by: ownerId,
        resolved_at: now,
        promoted_at: now,
      },
      { onConflict: 'memory_id' }
    );
    if (upErr) {
      throw new Error(`promote_rule: upsert failed: ${upErr.message}`);
    }

    await this.#audit('incubator.promote_on_demand', {
      memory_id: memoryId,
      target_layer: targetLayer,
      applies_scope: appliesScope ?? '',
    });

    return {
      memory_id: memoryId,
      rule_text: text,
      target_layer: targetLayer,
      applies_scope: appliesScope ?? null,
      status: 'promoted',
    };
  }

  /** Expired snoozes return to the queue in place (never re-inserted). */
  async #unsnoozeExpired(): Promise<number> {
    const { data, error } = await this.client
      .from('rule_candidates')
      .update({ status: 'pending', snoozed_until: null })
      .eq('status', 'snoozed')
      .lte('snoozed_until', new Date().toISOString())
      .select('id');
    if (error) {
      throw new Error(`incubator: un-snooze sweep failed: ${error.message}`);
    }
    return data?.length ?? 0;
  }

  /**
   * Inserts the candidacy row (draft-less) and returns its id, or null when
   * another run already claimed this memory (unique memory_id).
   */
  async #insertCandidate(row: RollupRow): Promise<string | null> {
    const { data, error } = await this.client
      .from('rule_candidates')
      .upsert(
        {
          memory_id: row.memory_id,
          useful_sessions: row.useful_sessions,
          window_days: this.config.windowDays,
          first_used_at: row.first_used_at,
          last_used_at: row.last_used_at,
          session_keys: row.session_keys,
        },
        { onConflict: 'memory_id', ignoreDuplicates: true }
      )
      .select('id');
    if (error) {
      throw new Error(
        `incubator: enqueue ${row.memory_id} failed: ${error.message}`
      );
    }
    return data?.[0]?.id ?? null;
  }

  /**
   * Same-owner graph neighbours of the candidate (both link directions,
   * capped) — context for the distiller, per the one-memory-one-candidate
   * design.
   */
  async #loadNeighbors(row: RollupRow): Promise<NeighborSnapshot[]> {
    const { data: links, error } = await this.client
      .from('memory_links')
      .select('src, dst')
      .or(`src.eq.${row.memory_id},dst.eq.${row.memory_id}`)
      .limit(this.config.maxNeighbors * 2);
    if (error) {
      throw new Error(
        `incubator: neighbour lookup for ${row.memory_id} failed: ` +
          error.message
      );
    }
    const neighborIds = [
      ...new Set(
        ((links ?? []) as LinkRow[])
          .map((link) => (link.src === row.memory_id ? link.dst : link.src))
          .filter((id) => id !== row.memory_id)
      ),
    ].slice(0, this.config.maxNeighbors);
    if (neighborIds.length === 0) {
      return [];
    }

    const { data: memories, error: memError } = await this.client
      .from('memories')
      .select('id, kind, content, owner_id')
      .in('id', neighborIds)
      .is('invalidated_at', null);
    if (memError) {
      throw new Error(
        `incubator: neighbour load for ${row.memory_id} failed: ` +
          memError.message
      );
    }
    return (memories ?? [])
      .filter((memory) => memory.owner_id === row.owner_id)
      .map((memory) => ({
        id: memory.id,
        kind: memory.kind,
        content: memory.content,
      }));
  }

  /**
   * Owner's scope inventory for the distiller: every scope holding active
   * memories, most-populated first, with short content samples so applicability
   * is judged by what lives there (scope names carry no project identity).
   * Solo-only leakage posture — see {@link ScopeInventoryEntry}.
   */
  async #loadScopeInventory(ownerId: string): Promise<ScopeInventoryEntry[]> {
    // Paged: this COUNTS memories per scope, so a capped read does not merely
    // miss rows — it reports wrong numbers, which is worse than reporting none.
    const data = await readAllPages(
      (from, to) =>
        this.client
          .from('memories')
          .select('scope')
          .eq('owner_id', ownerId)
          .is('invalidated_at', null)
          .order('id', { ascending: true })
          .range(from, to),
      { label: `incubator: scope inventory for ${ownerId}` }
    );
    const counts = new Map<string, number>();
    for (const row of data ?? []) {
      const scope = String(row.scope);
      counts.set(scope, (counts.get(scope) ?? 0) + 1);
    }
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_INVENTORY_SCOPES)
      .map(([scope]) => scope);

    const entries: ScopeInventoryEntry[] = [];
    for (const scope of top) {
      const { data: samples, error: sampleError } = await this.client
        .from('memories')
        .select('content')
        .eq('owner_id', ownerId)
        .eq('scope', scope)
        .is('invalidated_at', null)
        .order('created_at', { ascending: false })
        .limit(SAMPLES_PER_SCOPE);
      if (sampleError) {
        throw new Error(
          `incubator: scope samples for ${scope} failed: ${sampleError.message}`
        );
      }
      entries.push({
        scope,
        samples: (samples ?? []).map((memory) =>
          String(memory.content).slice(0, SAMPLE_CHARS)
        ),
      });
    }
    return entries;
  }

  async #saveDraft(
    candidateId: string,
    row: RollupRow,
    judgement: RuleDistillerJudgement,
    inventory: ScopeInventoryEntry[]
  ): Promise<void> {
    // Ranked recommendation: deterministic origin entry + inventory-validated
    // speculative LLM guesses (the owner decides where to actually apply).
    const suggestedScopes = mergeScopeSuggestions(
      row.scope,
      judgement.verdict.scope_suggestions ?? [],
      inventory.map((entry) => entry.scope)
    );
    const { error } = await this.client
      .from('rule_candidates')
      .update({
        rule_text: judgement.verdict.rule_text,
        target_layer: targetLayerForScope(row.scope),
        judge_confidence: judgement.verdict.confidence,
        judge_rationale: judgement.verdict.rationale,
        judge_model: judgement.model,
        suggested_scopes: suggestedScopes,
      })
      .eq('id', candidateId);
    if (error) {
      throw new Error(
        `incubator: draft save for ${candidateId} failed: ${error.message}`
      );
    }
    await this.#audit('incubator.distill', {
      candidate: candidateId,
      memory_id: row.memory_id,
      useful_sessions: row.useful_sessions,
      confidence: judgement.verdict.confidence,
      model: judgement.model,
    });
  }

  /** The distiller is unconvinced: close the candidacy without human time. */
  async #autoDismiss(
    candidateId: string,
    memoryId: string,
    judgement: RuleDistillerJudgement
  ): Promise<void> {
    const { error } = await this.client
      .from('rule_candidates')
      .update({
        status: 'dismissed',
        resolution: 'low_confidence',
        resolved_at: new Date().toISOString(),
        judge_confidence: judgement.verdict.confidence,
        judge_rationale: judgement.verdict.rationale,
        judge_model: judgement.model,
      })
      .eq('id', candidateId);
    if (error) {
      throw new Error(
        `incubator: auto-dismiss for ${candidateId} failed: ${error.message}`
      );
    }
    await this.#audit('incubator.auto_dismiss', {
      candidate: candidateId,
      memory_id: memoryId,
      confidence: judgement.verdict.confidence,
      model: judgement.model,
    });
  }

  /** Meter one distiller call's tokens (best-effort, service-role). */
  async #meterDistill(
    judgement: Pick<
      RuleDistillerJudgement,
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
      agent_name: AGENT_NAME,
      metadata: {
        purpose: 'rule_distiller',
        model: judgement.model,
        input_tokens: judgement.inputTokens,
        output_tokens: judgement.outputTokens,
        ...(judgement.ranOnCallerKey ? { own_key: true } : {}),
      },
    });
    if (error) {
      this.#logger.warn('incubator: distill metering failed', {
        error: error.message,
      });
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
      agent_name: AGENT_NAME,
    });
    if (error) {
      // Audit is best-effort context, not the operation itself: log and move on.
      this.#logger.warn('incubator: audit write failed', {
        command,
        error: error.message,
      });
    }
  }
}
