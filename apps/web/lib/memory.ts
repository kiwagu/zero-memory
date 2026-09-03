import type { Database } from '@workspace/db';
import type { WebTranslator } from '@workspace/i18n-catalogs/web';
import type {
  MemoryBadgeItem,
  MemoryCardProps,
} from '@workspace/ui/components/memory/memory-card';
import { scopeDisplay } from '@workspace/ui/lib/scope-format';

/** All memory columns except the heavy ones (embedding, fts). */
export const MEMORY_COLUMNS =
  'id, content, content_original, content_lang, kind, scope, visibility, ' +
  'owner_id, author_kind, agent_name, source, valid_from, invalidated_at, ' +
  'invalidated_by, invalidated_by_agent, invalidated_by_model, superseded_by, ' +
  'shared_at, shared_by, created_at';

export type MemoryRow = Omit<
  Database['public']['Tables']['memories']['Row'],
  'embedding' | 'fts'
>;

export const MEMORY_KINDS = [
  'fact',
  'preference',
  'decision',
  'convention',
  'gotcha',
  'reference',
  'episode',
  'task',
  'open-question',
] as const;

export const VISIBILITIES = ['private', 'shared'] as const;

/**
 * Lifecycle statuses the feed can be filtered by. The default (`active`) hides
 * HISTORICAL VERSIONS only — a retired memory whose content lives on in a
 * successor, reachable from that successor's card. A LONE INVALIDATION (retired
 * with nothing replacing it: a manual forget, a conflict resolution, a hygiene
 * auto-invalidation) deliberately STAYS in the default view, dimmed and badged:
 * a disappearance without a successor is the only observable manifestation of
 * both deliberate cleanup and a FALSE invalidation, so hiding it together with
 * history would make a regression of that protection invisible exactly where it
 * has to be noticed.
 *
 * `live` is the narrower reading of "not retired": it drops the lone
 * invalidations too. The default keeps them on purpose, but for the loop kinds
 * (a task, an open question) a lone invalidation is a CLOSED loop, and "show me
 * only what is still open" needs a value of its own.
 */
export const FEED_STATUSES = [
  'active',
  'live',
  'superseded',
  'invalidated',
  'all',
] as const;

export type FeedStatus = (typeof FEED_STATUSES)[number];

export const DEFAULT_FEED_STATUS: FeedStatus = 'active';

/** URL param → status, falling back to the default for anything unknown. */
export function parseFeedStatus(raw: string | undefined): FeedStatus {
  return FEED_STATUSES.find((status) => status === raw) ?? DEFAULT_FEED_STATUS;
}

/**
 * Does a memory belong in the feed under this status? The twin of the SQL
 * filter the feed query applies (see the memories page) — kept pure so the
 * realtime insert path can reuse it client-side.
 */
export function matchesFeedStatus(
  memory: Pick<MemoryRow, 'invalidated_at' | 'superseded_by'>,
  status: FeedStatus
): boolean {
  const retired = Boolean(memory.invalidated_at);
  const replaced = Boolean(memory.superseded_by);
  switch (status) {
    case 'active':
      // Everything except a historical version (retired AND replaced).
      return !retired || !replaced;
    case 'live':
      return !retired;
    case 'superseded':
      return retired && replaced;
    case 'invalidated':
      return retired && !replaced;
    case 'all':
      return true;
  }
}

export const SCOPE_ROLES = ['reader', 'writer', 'admin'] as const;

export const PAGE_SIZE = 25;

/**
 * A feed search that targets a memory id: `mem_` plus any prefix of the id
 * body (the card shows the full id, so any copied fragment must find it).
 * The char class mirrors Crockford base32 from the entity-id package, which
 * web cannot import (NodeNext `.js` internals do not resolve under
 * Turbopack — same constraint as @workspace/contracts).
 */
/** Exported for the drift test that pins it to the canonical Crockford class. */
export const MEM_ID_QUERY_RE =
  /^mem_[0-9a-hjkmnp-tv-z]{1,16}(?:\.[0-9a-hjkmnp-tv-z]{0,10})?$/;

/** Normalized id-prefix for a `like` filter, or null → content search. */
export function memoryIdSearchPrefix(q: string): string | null {
  const candidate = q.trim().toLowerCase();
  return MEM_ID_QUERY_RE.test(candidate) ? candidate : null;
}

/** The feed filters whose options are counted against the current selection. */
export const FACET_NAMES = ['kind', 'visibility', 'scope', 'status'] as const;

export type FacetName = (typeof FACET_NAMES)[number];

/** One row of the facet-count RPC: how many memories a value would yield. */
export interface FacetCountRow {
  facet: string;
  value: string;
  total: number;
}

/** Counts indexed by `facet:value`; a missing key means the value yields none. */
export type FacetCounts = Map<string, number>;

export function facetCountIndex(rows: FacetCountRow[]): FacetCounts {
  return new Map(rows.map((row) => [`${row.facet}:${row.value}`, row.total]));
}

export function facetCount(
  counts: FacetCounts,
  facet: FacetName,
  value: string
): number {
  return counts.get(`${facet}:${value}`) ?? 0;
}

/**
 * Annotate a facet's options with their counts and disable the ones that lead
 * to an empty feed. Empty values are DIMMED, not removed: dropping them would
 * change the list on every selection and could make the value the URL currently
 * applies vanish, leaving the address and the interface saying different
 * things. For the same reason the applied value is never disabled — it has to
 * stay selectable so it can be switched away from.
 */
export function annotateFacetOptions<
  T extends { value: string; label: string },
>(
  options: T[],
  facet: FacetName,
  counts: FacetCounts,
  applied: string
): (T & { count: number; disabled: boolean })[] {
  return options.map((option) => {
    const count = facetCount(counts, facet, option.value);
    return {
      ...option,
      count,
      disabled: count === 0 && option.value !== applied,
    };
  });
}

/**
 * The count behind a facet's placeholder row — "any value of this facet" under
 * the other filters, which is the sum of its options. The status facet is the
 * exception: its placeholder IS a value (the default status), so the caller
 * passes that value instead of summing mutually overlapping buckets.
 */
export function facetTotal(counts: FacetCounts, facet: FacetName): number {
  let total = 0;
  for (const [key, value] of counts) {
    if (key.startsWith(`${facet}:`)) {
      total += value;
    }
  }
  return total;
}

/** Deterministic (locale-free) timestamp for server-rendered markup. */
export function formatTimestamp(value: string | null): string {
  if (!value) {
    return '—';
  }
  return `${new Date(value).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

/**
 * Scope as a badge reads it: the per-owner `usr_…` segment collapsed away.
 *
 * That segment is identical for every scope of one user, so it is pure noise in
 * a chip — and it is the one part of a scope path nobody should have to read off
 * a shared screen or a screenshot. The informative parts (the root and the
 * project slug) survive. The full path stays available where it is the subject
 * rather than a label: the scopes page.
 */
export function scopeLabel(scope: unknown): string {
  return scopeDisplay(scope);
}

/** Literal keys only (lint-enforced): dynamic `t(\`kind.${…}\`)` is banned. */
export function kindLabel(kind: string, t: WebTranslator): string {
  switch (kind) {
    case 'fact':
      return t('kind.fact');
    case 'preference':
      return t('kind.preference');
    case 'decision':
      return t('kind.decision');
    case 'convention':
      return t('kind.convention');
    case 'gotcha':
      return t('kind.gotcha');
    case 'reference':
      return t('kind.reference');
    case 'episode':
      return t('kind.episode');
    case 'task':
      return t('kind.task');
    case 'open-question':
      return t('kind.open-question');
    default:
      return kind;
  }
}

/** Literal keys only (lint-enforced), same as kindLabel. */
export function feedStatusLabel(status: FeedStatus, t: WebTranslator): string {
  switch (status) {
    case 'active':
      return t('feed.status.active');
    case 'live':
      return t('feed.status.live');
    case 'superseded':
      return t('feed.status.superseded');
    case 'invalidated':
      return t('feed.status.invalidated');
    case 'all':
      return t('feed.status.all');
  }
}

export function visibilityLabel(visibility: string, t: WebTranslator): string {
  switch (visibility) {
    case 'shared':
      // The feed's visibility filter reads "sharable": `visibility='shared'`
      // only means the memory lives in a shareable scope (a capability), which
      // is what the filter selects. The card badge is more precise (see
      // sharingBadge) because it also knows the member count.
      return t('visibility.sharable');
    case 'private':
      return t('visibility.private');
    default:
      return visibility;
  }
}

/**
 * The honest sharing badge for a memory card. `visibility='shared'` only means
 * the memory lives in a shareable scope (proj.* or team.*) — a capability, not
 * the fact anyone else can see it. So it reads "shared" (green) ONLY when the
 * scope actually has members beyond the owner (`memberCount > 1`); with the
 * owner alone it is merely "sharable" (secondary). An UNKNOWN count (a realtime
 * insert rendered without the server-resolved map) degrades to "shared" rather
 * than understating reach.
 */
export function sharingBadge(
  visibility: string,
  memberCount: number | undefined,
  t: WebTranslator
): MemoryBadgeItem {
  if (visibility === 'private') {
    return {
      label: t('visibility.private'),
      variant: 'secondary',
      testId: 'memory-visibility-badge',
    };
  }
  const sharable = memberCount !== undefined && memberCount <= 1;
  return {
    label: sharable ? t('visibility.sharable') : t('visibility.shared'),
    variant: sharable ? 'secondary' : 'green',
    testId: 'memory-visibility-badge',
  };
}

export function roleLabel(role: string, t: WebTranslator): string {
  switch (role) {
    case 'admin':
      return t('role.admin');
    case 'writer':
      return t('role.writer');
    case 'reader':
      return t('role.reader');
    default:
      return role;
  }
}

/** Brand labels for the raw provenance identifiers (agent_name from a direct
 * write, or source.client from ingest). Proper nouns, so not translated. */
const CLIENT_LABELS: readonly [RegExp, string][] = [
  [/cursor/i, 'Cursor'],
  [/codex/i, 'Codex'],
  [/claude/i, 'Claude Code'],
  // This dashboard writing through the server's own MCP endpoint. It reaches a
  // badge now that a merge records the person who typed it, and "zm-web" is an
  // internal identifier no reader should have to decode.
  [/^zm-web$/i, 'Dashboard'],
];

const normalizeClient = (raw: string): string => {
  for (const [pattern, label] of CLIENT_LABELS) {
    if (pattern.test(raw)) return label;
  }
  return raw;
};

/**
 * The tool a memory is attributable to. A direct agent write carries the
 * client in `agent_name` (its MCP clientInfo.name); an ingest write keeps the
 * provisional `watcher`/`bootstrap` agent_name and carries the client in
 * `source.client` — so prefer a specific agent_name, else fall back to it.
 */
export function memoryClient(memory: MemoryRow): string | null {
  const source = memory.source as { client?: unknown } | null;
  const sourceClient =
    typeof source?.client === 'string' ? source.client : null;
  const generic =
    memory.agent_name === 'watcher' || memory.agent_name === 'bootstrap';
  const raw = memory.agent_name && !generic ? memory.agent_name : sourceClient;
  return raw ? normalizeClient(raw) : (memory.agent_name ?? null);
}

export function memoryBadges(
  memory: MemoryRow,
  t: WebTranslator,
  memberCount?: number
): MemoryBadgeItem[] {
  const client = memoryClient(memory);
  const badges: MemoryBadgeItem[] = [
    { label: kindLabel(memory.kind, t), variant: 'blue' },
    sharingBadge(memory.visibility, memberCount, t),
    { label: scopeLabel(memory.scope), variant: 'amber' },
    {
      label: client ? `${memory.author_kind} · ${client}` : memory.author_kind,
      variant: 'secondary',
    },
  ];
  if (memory.invalidated_at) {
    badges.push({
      label: t('memory.invalidated'),
      variant: 'destructive',
      testId: 'memory-invalidated-badge',
    });
  }
  return badges;
}

/**
 * Link to a memory's detail page, carrying the feed's current filter query as
 * `from` so the detail's "back to feed" returns to the same filtered view
 * instead of a reset feed. `backTo` is a bare query string (e.g.
 * `scope=proj.x&kind=decision`); empty means no filters to preserve.
 */
export function memoryHref(id: string, backTo?: string): string {
  return backTo
    ? `/memory/${id}?from=${encodeURIComponent(backTo)}`
    : `/memory/${id}`;
}

/**
 * MemoryRow → display-ready props of the vendor-neutral MemoryCard.
 * `hasHistory` adds a badge flagging that the memory is part of a supersession
 * chain (older versions to see on the detail page). `backTo` carries the feed's
 * current filters so the detail can link back to them.
 */
export function memoryCardProps(
  memory: MemoryRow,
  t: WebTranslator,
  hasHistory = false,
  memberCount?: number,
  backTo?: string
): Omit<MemoryCardProps, 'linkComponent'> {
  const badges = memoryBadges(memory, t, memberCount);
  if (hasHistory) {
    badges.push({
      label: t('memory.hasHistory'),
      variant: 'amber',
      testId: 'memory-history-badge',
    });
  }
  return {
    content: memory.content,
    href: memoryHref(memory.id, backTo),
    badges,
    memoryId: memory.id,
    timestamp: formatTimestamp(memory.created_at),
    muted: Boolean(memory.invalidated_at),
    original: originalProps(memory, t),
  };
}

/**
 * The original-language source to reveal on a card, if any: the pre-translation
 * `content_original` (drift-audit target) preferred, else the author-supplied
 * `verbatim` idiom snippet in provenance. Returns undefined for born-English
 * memories that never had another language.
 *
 * A same-language "Original (en)" is deliberately NOT masked here: it means the
 * write path let an English row through with an original stored, and surfacing
 * it on the card is the audit signal that the write-path protection is weak.
 * The real fix lives at the source (MemoryService.#canonicalize marks such rows
 * 'skipped' with no content_original) — hiding the symptom would only remove
 * the ability to notice a future regression.
 */
export function originalProps(
  memory: MemoryRow,
  t: WebTranslator
): MemoryCardProps['original'] {
  const source = memory.content_original
    ? { text: memory.content_original, lang: memory.content_lang }
    : verbatimOf(memory.source);
  if (!source) {
    return undefined;
  }
  return {
    text: source.text,
    lang: source.lang,
    label: source.lang
      ? t('memory.original.withLang', { lang: source.lang })
      : t('memory.original.plain'),
  };
}

/** Extracts a non-empty `verbatim` string from the free-form source jsonb. */
function verbatimOf(
  source: MemoryRow['source']
): { text: string; lang: string | null } | null {
  const verbatim = (source as { verbatim?: unknown } | null)?.verbatim;
  return typeof verbatim === 'string' && verbatim.trim()
    ? { text: verbatim, lang: null }
    : null;
}
