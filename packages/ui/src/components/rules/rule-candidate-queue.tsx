'use client';

import * as React from 'react';

import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '@workspace/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components/select';
import { Markdown } from '@workspace/ui/components/common/markdown';
import { Input } from '@workspace/ui/components/input';
import { Switch } from '@workspace/ui/components/switch';
import { Textarea } from '@workspace/ui/components/textarea';
import {
  RULE_EXPORT_FORMATS,
  renderRuleFile,
  type RuleExportLayer,
} from '@workspace/ui/lib/rule-formats';

/** Sentinel value of the addressing select's general (every-session) option. */
const ADDRESS_GENERAL = '__general__';

/** Project scopes the rule could be addressed to, origin-ranked, deduped. */
const projectOptions = (item: RuleCandidateItem): string[] => [
  ...new Set(
    item.scopes
      .map((entry) => entry.scope)
      .filter((scope) => scope.startsWith('proj.') || scope.startsWith('team.'))
  ),
];

/**
 * The default addressing TACTIC: when the rule clearly belongs to a project
 * (any project scope in its ranked recommendation — the origin scope or a
 * distiller suggestion), default to THAT project rather than the general
 * layer. The general layer loads in every session, so the boundary is easy
 * to miss in the wrong direction; project-first keeps a project-specific
 * rule out of unrelated sessions unless the owner deliberately widens it.
 */
export const defaultAddressing = (
  item: RuleCandidateItem
): RuleAddressingChoice => {
  const options = projectOptions(item);
  return options.length > 0
    ? { targetLayer: 'project', appliesScope: options[0] }
    : { targetLayer: 'user' };
};

/** Addressing select + promote button of one pending card. */
function PendingPromote({
  item,
  busy,
  labels,
  onResolve,
}: {
  item: RuleCandidateItem;
  busy: boolean;
  labels: RuleCandidateQueueLabels;
  onResolve: (
    id: string,
    action: RuleCandidateAction,
    addressing?: RuleAddressingChoice
  ) => void;
}) {
  const options = projectOptions(item);
  const initial = defaultAddressing(item);
  const [address, setAddress] = React.useState(
    initial.targetLayer === 'project'
      ? (initial.appliesScope ?? ADDRESS_GENERAL)
      : ADDRESS_GENERAL
  );
  const items = React.useMemo(
    () => ({
      [ADDRESS_GENERAL]: labels.target.user,
      ...Object.fromEntries(options.map((scope) => [scope, scope])),
    }),
    [options, labels.target.user]
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-sm">
          {labels.addressTo}
        </span>
        <Select
          value={address}
          items={items}
          onValueChange={(next) => setAddress(String(next))}
        >
          <SelectTrigger
            size="sm"
            className="max-w-72 [&>span]:truncate"
            data-testid="rule-address-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="w-max min-w-(--anchor-width) max-w-[28rem]">
            <SelectItem value={ADDRESS_GENERAL}>
              {labels.target.user}
            </SelectItem>
            {options.map((scope) => (
              <SelectItem key={scope} value={scope}>
                <span className="block max-w-[26rem] truncate" title={scope}>
                  {scope}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          disabled={busy}
          data-testid="rule-approve"
          onClick={() =>
            onResolve(
              item.id,
              'promote',
              address === ADDRESS_GENERAL
                ? { targetLayer: 'user' }
                : { targetLayer: 'project', appliesScope: address }
            )
          }
        >
          {labels.actions.promote}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">{labels.addressHint}</p>
    </div>
  );
}

/** The stats line of a promoted rule, from its template. */
const statsLine = (
  template: string,
  stats: NonNullable<RuleCandidateItem['stats']>
): string =>
  template
    .replace('{calls}', String(stats.calls))
    .replace('{full}', String(stats.full))
    .replace('{gate}', String(stats.gate))
    .replace('{headline}', String(stats.headline))
    .replace('{meanP}', stats.meanP === null ? '—' : stats.meanP.toFixed(2))
    .replace('{fetches}', String(stats.fetches));

/**
 * Saves an inline field when it loses focus, or on Enter, and only when its
 * text changed. Shift+Enter still breaks a line in a textarea.
 */
const saveOnCommit = (saved: string, onSave: (value: string) => void) => ({
  onBlur: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const value = event.currentTarget.value.trim();
    if (value !== saved) {
      onSave(value);
    }
  },
  onKeyDown: (
    event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.blur();
    }
  },
});

/**
 * What the delivery judge reads about a promoted rule — when it applies and
 * which guard enforces it — edited in place, and how the rule was delivered
 * lately. Each field is keyed by its stored value, so a refresh that brings a
 * new value back resets the field to it.
 */
function PromotedRuleDelivery({
  item,
  busy,
  labels,
  onAppliesWhen,
  onEnforcedBy,
}: {
  item: RuleCandidateItem;
  busy: boolean;
  labels: RuleCandidateQueueLabels;
  onAppliesWhen?: (item: RuleCandidateItem, value: string) => void;
  onEnforcedBy?: (item: RuleCandidateItem, value: string) => void;
}) {
  const appliesWhen = item.appliesWhen ?? '';
  const enforcedBy = item.enforcedBy ?? '';
  const appliesWhenId = `rule-applies-when-${item.id}`;
  const enforcedById = `rule-enforced-by-${item.id}`;
  return (
    <div className="space-y-3">
      {onAppliesWhen ? (
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor={appliesWhenId}>
            {labels.appliesWhen.label}
          </label>
          <Textarea
            key={appliesWhen}
            id={appliesWhenId}
            data-testid="rule-applies-when"
            className="min-h-12"
            maxLength={400}
            defaultValue={appliesWhen}
            placeholder={labels.appliesWhen.placeholder}
            disabled={busy}
            {...saveOnCommit(appliesWhen, (value) =>
              onAppliesWhen(item, value)
            )}
          />
          {appliesWhen === '' ? (
            <p
              className="text-muted-foreground text-xs"
              data-testid="rule-applies-when-missing"
            >
              {labels.appliesWhen.missing}
            </p>
          ) : null}
        </div>
      ) : null}
      {onEnforcedBy ? (
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor={enforcedById}>
            {labels.enforcedBy.label}
          </label>
          <Input
            key={enforcedBy}
            id={enforcedById}
            data-testid="rule-enforced-by"
            className="max-w-sm font-mono"
            maxLength={64}
            defaultValue={enforcedBy}
            placeholder={labels.enforcedBy.placeholder}
            disabled={busy}
            spellCheck={false}
            {...saveOnCommit(enforcedBy, (value) => onEnforcedBy(item, value))}
          />
        </div>
      ) : null}
      {item.stats ? (
        <p className="text-muted-foreground text-xs" data-testid="rule-stats">
          <span className="font-medium">{labels.stats.title}:</span>{' '}
          {statsLine(labels.stats.line, item.stats)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Rules-incubator review surface. Mechanism only: rows and labels arrive
 * translated, resolutions are injected callbacks, and the caller owns
 * pending/error state. Each card shows the distilled rule draft with its
 * usage evidence; a promoted card swaps the actions for copy/download — the
 * server never writes the user's rules files, the owner applies the text
 * themselves.
 */

export type RuleCandidateAction = 'promote' | 'dismiss' | 'snooze';

export type RuleTargetLayerKind = RuleExportLayer;

/**
 * One entry of the ranked "where this rule applies" recommendation. `origin`
 * and `global` are deterministic; `llm` entries are speculative distiller
 * guesses — shown as hints, never enforced (the owner decides).
 */
/**
 * The addressing decision made at promotion: the general (every-session)
 * layer, or one concrete project scope the rule binds to.
 */
export interface RuleAddressingChoice {
  targetLayer: RuleTargetLayerKind;
  appliesScope?: string;
}

export interface RuleScopeSuggestion {
  scope: string;
  score: number;
  source: 'origin' | 'global' | 'llm';
}

export interface RuleCandidateItem {
  id: string;
  status: 'pending' | 'promoted' | 'dismissed';
  /** Distilled imperative rule text (markdown) — the artifact itself. */
  ruleText: string;
  targetLayer: RuleTargetLayerKind;
  confidence: number | null;
  rationale: string | null;
  /** Distinct sessions in which the source memory fired usefully. */
  usefulSessions: number;
  /** Pre-formatted first/last usefulness timestamps. */
  firstUsed: string | null;
  lastUsed: string | null;
  memory: {
    id: string;
    kind: string;
    scope: string;
    /** Link to the memory's detail page (resolved by the app). */
    href: string;
  };
  /** Ranked scopes where the rule likely applies (origin entry first). */
  scopes: RuleScopeSuggestion[];
  /**
   * Owner-pinned delivery of a PROMOTED rule: exempt from the delivery cap
   * and TTL, and delivered first in the briefing's rules[]. Only meaningful
   * once the rule is promoted.
   */
  pinned?: boolean;
  /**
   * Review hint for a PROMOTED rule whose source memory has gone cold (no
   * recent usefulness reinforcement) — a light "still relevant?" signal. The
   * app pre-formats it; absent/null when the rule still has live evidence.
   */
  staleSignal?: string | null;
  /**
   * A PROMOTED rule moved to the successor of its memory but kept a curated
   * text, which may no longer say what the successor says. Pre-formatted by
   * the app; absent/null otherwise.
   */
  reviewSignal?: string | null;
  /**
   * A PROMOTED rule still anchored to a memory that was retired: superseded
   * without the rule moving along, or forgotten. It stays promoted.
   * Pre-formatted by the app; absent/null otherwise.
   */
  sourceSignal?: string | null;
  /** The memory this rule last moved away from, when it moved. */
  carriedFrom?: { id: string; href: string } | null;
  /**
   * When a PROMOTED rule binds a task, as observable task features: what the
   * delivery judge tests the task against. Null until someone says.
   */
  appliesWhen?: string | null;
  /** The client-side guard that enforces the rule, by the name it prints. */
  enforcedBy?: string | null;
  /**
   * How the delivery judge delivered a PROMOTED rule lately: calls that
   * listed it, per level, the mean probability, and full-text reads after a
   * headline. Null or absent when nothing was measured.
   */
  stats?: {
    calls: number;
    full: number;
    gate: number;
    headline: number;
    meanP: number | null;
    fetches: number;
  } | null;
}

export interface RuleCandidateQueueLabels {
  empty: string;
  /** "Confidence {value}" — `{value}` is replaced with the score. */
  confidence: string;
  /** "Fired usefully in {sessions} sessions" — `{sessions}` is replaced. */
  evidence: string;
  /** "first {date}" / "last {date}" — `{date}` is replaced. */
  evidenceFirst: string;
  evidenceLast: string;
  sourceMemory: string;
  target: Record<RuleTargetLayerKind, string>;
  /** Where to paste the approved rule, per layer. */
  targetHint: Record<RuleTargetLayerKind, string>;
  actions: Record<RuleCandidateAction | 'delete', string>;
  copy: string;
  copied: string;
  /** Trigger label for the download-format dropdown. */
  download: string;
  /** Revoke a promoted rule (pull it back out of the always-on layer). */
  revoke: string;
  promotedBadge: string;
  dismissedBadge: string;
  /** Label ahead of the ranked "where this rule applies" chips. */
  appliesTo: string;
  /** Label of the promotion addressing select. */
  addressTo: string;
  /** Boundary hint: project rules load only in their project's sessions. */
  addressHint: string;
  /** Caption of the delivery-pin switch on a promoted rule. */
  pin: string;
  /** What pinning guarantees (switch tooltip). */
  pinHint: string;
  /** Badge on a pinned rule's card. */
  pinnedBadge: string;
  /** Label ahead of the memory a rule moved away from. */
  carriedFrom: string;
  /** The inline "applies when" editor of a promoted rule. */
  appliesWhen: { label: string; placeholder: string; missing: string };
  /** The inline guard-name editor of a promoted rule. */
  enforcedBy: { label: string; placeholder: string };
  /**
   * The delivery stats of a promoted rule. `line` carries {calls}, {full},
   * {gate}, {headline}, {meanP} and {fetches}.
   */
  stats: { title: string; line: string };
}

/** Client-side download of the rendered rule file for one environment. */
function downloadRuleFile(
  item: RuleCandidateItem,
  format: (typeof RULE_EXPORT_FORMATS)[number]['format']
): void {
  const file = renderRuleFile(format, {
    ruleText: item.ruleText,
    targetLayer: item.targetLayer,
    id: item.id,
  });
  const blob = new Blob([file.content], { type: file.mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Download dropdown: one entry per supported agent environment. */
function DownloadMenu({
  item,
  label,
}: {
  item: RuleCandidateItem;
  label: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="sm" variant="outline" data-testid="rule-download" />
        }
      >
        {label}
      </DropdownMenuTrigger>
      {/* Size to the content, not the narrow trigger, so long environment
          names and paths stay on one line instead of wrapping. */}
      <DropdownMenuContent
        align="start"
        className="w-max min-w-64 max-w-[calc(100vw-2rem)]"
      >
        {RULE_EXPORT_FORMATS.map((meta) => (
          <DropdownMenuItem
            key={meta.format}
            data-testid={`rule-download-${meta.format}`}
            onClick={() => downloadRuleFile(item, meta.format)}
          >
            <span className="flex flex-col">
              <span className="whitespace-nowrap">{meta.label}</span>
              <span className="text-muted-foreground font-mono text-xs whitespace-nowrap">
                {meta.path[item.targetLayer]}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CopyButton({
  text,
  labels,
}: {
  text: string;
  labels: Pick<RuleCandidateQueueLabels, 'copy' | 'copied'>;
}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      data-testid="rule-copy"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? labels.copied : labels.copy}
    </Button>
  );
}

export function RuleCandidateQueue({
  items,
  labels,
  pendingId,
  error,
  onResolve,
  onRevoke,
  onDelete,
  onTogglePin,
  onAppliesWhen,
  onEnforcedBy,
  linkComponent: LinkComponent = 'a',
}: {
  items: RuleCandidateItem[];
  labels: RuleCandidateQueueLabels;
  pendingId: string | null;
  error: string | null;
  onResolve: (
    id: string,
    action: RuleCandidateAction,
    addressing?: RuleAddressingChoice
  ) => void;
  /** Open the revoke-reason dialog for a promoted rule (app owns the dialog). */
  onRevoke: (item: RuleCandidateItem) => void;
  /** Open the delete confirmation for a dismissed rule (app owns the dialog). */
  onDelete?: (item: RuleCandidateItem) => void;
  /** Toggle the instructions pin of a promoted General rule. */
  onTogglePin?: (item: RuleCandidateItem, pinned: boolean) => void;
  /** Save what a promoted rule's "applies when" field now says ('' clears it). */
  onAppliesWhen?: (item: RuleCandidateItem, value: string) => void;
  /** Save the guard a promoted rule is enforced by ('' clears it). */
  onEnforcedBy?: (item: RuleCandidateItem, value: string) => void;
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
}) {
  if (items.length === 0) {
    return (
      <p data-testid="rules-empty" className="text-muted-foreground text-sm">
        {labels.empty}
      </p>
    );
  }

  return (
    <div data-testid="rules-queue" className="space-y-4">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {items.map((item) => {
        const busy = pendingId === item.id;
        const evidence = labels.evidence.replace(
          '{sessions}',
          String(item.usefulSessions)
        );
        return (
          <Card key={item.id} data-testid="rule-item">
            <CardHeader>
              <div className="space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-base">
                    {labels.target[item.targetLayer]}
                  </CardTitle>
                  {/* The source memory's scope: the rule's suggested home —
                      the author decides which layer to actually paste it in. */}
                  <Badge
                    variant="outline"
                    className="font-mono"
                    data-testid="rule-scope"
                  >
                    {item.memory.scope}
                  </Badge>
                  {item.status === 'promoted' ? (
                    <Badge variant="secondary" data-testid="rule-promoted">
                      {labels.promotedBadge}
                    </Badge>
                  ) : null}
                  {item.pinned ? (
                    <Badge variant="amber" data-testid="rule-pinned">
                      {labels.pinnedBadge}
                    </Badge>
                  ) : null}
                  {item.status === 'dismissed' ? (
                    <Badge variant="outline" data-testid="rule-dismissed">
                      {labels.dismissedBadge}
                    </Badge>
                  ) : null}
                </div>
                <p
                  className="text-muted-foreground font-mono text-xs select-all"
                  data-testid="rule-item-id"
                >
                  {item.id}
                </p>
              </div>
              {/* Right-aligned header slot: CardHeader is a grid, so the
                  action column is what keeps this level with the title. */}
              <CardAction className="flex items-center gap-3">
                {item.confidence != null ? (
                  <Badge variant="secondary">
                    {labels.confidence.replace(
                      '{value}',
                      item.confidence.toFixed(2)
                    )}
                  </Badge>
                ) : null}
                {/* Guaranteed delivery: a pinned rule is exempt from the
                    delivery cap and TTL and leads the briefing's rules[].
                    Both layers are capped, so either can be pinned. */}
                {onTogglePin && item.status === 'promoted' ? (
                  <label
                    className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs"
                    title={labels.pinHint}
                  >
                    {labels.pin}
                    <Switch
                      size="sm"
                      data-testid="rule-pin-toggle"
                      checked={item.pinned === true}
                      disabled={busy}
                      onCheckedChange={(checked) => onTogglePin(item, checked)}
                    />
                  </label>
                ) : null}
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-3">
              <div data-testid="rule-text" className="bg-muted rounded-md p-3">
                <Markdown>{item.ruleText}</Markdown>
              </div>
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span data-testid="rule-evidence">{evidence}</span>
                {item.firstUsed ? (
                  <>
                    <span>·</span>
                    <span>
                      {labels.evidenceFirst.replace('{date}', item.firstUsed)}
                    </span>
                  </>
                ) : null}
                {item.lastUsed ? (
                  <>
                    <span>·</span>
                    <span>
                      {labels.evidenceLast.replace('{date}', item.lastUsed)}
                    </span>
                  </>
                ) : null}
                <span>·</span>
                <span>{labels.sourceMemory}:</span>
                <LinkComponent
                  href={item.memory.href}
                  className="text-primary font-mono break-all select-all hover:underline"
                  data-testid="rule-memory-link"
                >
                  {item.memory.id}
                </LinkComponent>
                <span>({item.memory.kind})</span>
                {item.carriedFrom ? (
                  <>
                    <span>·</span>
                    <span>{labels.carriedFrom}:</span>
                    <LinkComponent
                      href={item.carriedFrom.href}
                      className="text-primary font-mono break-all select-all hover:underline"
                      data-testid="rule-carried-from"
                    >
                      {item.carriedFrom.id}
                    </LinkComponent>
                  </>
                ) : null}
              </div>
              {item.staleSignal ? (
                <Badge variant="amber" data-testid="rule-stale-signal">
                  {item.staleSignal}
                </Badge>
              ) : null}
              {item.reviewSignal ? (
                <Badge variant="amber" data-testid="rule-review-signal">
                  {item.reviewSignal}
                </Badge>
              ) : null}
              {item.sourceSignal ? (
                <Badge variant="amber" data-testid="rule-source-signal">
                  {item.sourceSignal}
                </Badge>
              ) : null}
              {item.scopes.length > 1 ? (
                <div
                  className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
                  data-testid="rule-applies-to"
                >
                  <span>{labels.appliesTo}</span>
                  {item.scopes.map((entry) => (
                    <Badge
                      key={entry.scope}
                      variant={
                        entry.source === 'origin' ? 'secondary' : 'outline'
                      }
                      className="font-mono"
                      data-testid={`rule-scope-${entry.source}`}
                      // Speculative entries carry their confidence as a hint.
                      title={
                        entry.source === 'origin'
                          ? undefined
                          : entry.score.toFixed(2)
                      }
                    >
                      {entry.scope}
                    </Badge>
                  ))}
                </div>
              ) : null}
              {item.rationale ? (
                <p className="text-muted-foreground text-sm italic">
                  {item.rationale}
                </p>
              ) : null}
              {item.status === 'pending' ? (
                <div className="space-y-2">
                  <PendingPromote
                    item={item}
                    busy={busy}
                    labels={labels}
                    onResolve={onResolve}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      data-testid="rule-snooze"
                      onClick={() => onResolve(item.id, 'snooze')}
                    >
                      {labels.actions.snooze}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      data-testid="rule-dismiss"
                      onClick={() => onResolve(item.id, 'dismiss')}
                    >
                      {labels.actions.dismiss}
                    </Button>
                  </div>
                </div>
              ) : item.status === 'promoted' ? (
                <div className="space-y-2">
                  <PromotedRuleDelivery
                    item={item}
                    busy={busy}
                    labels={labels}
                    onAppliesWhen={onAppliesWhen}
                    onEnforcedBy={onEnforcedBy}
                  />
                  <p className="text-muted-foreground text-sm">
                    {labels.targetHint[item.targetLayer]}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <CopyButton text={item.ruleText} labels={labels} />
                    <DownloadMenu item={item} label={labels.download} />
                    {/* Pull a promoted rule back out of the always-on layer
                        if it proved unneeded — reason captured by the app. */}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      data-testid="rule-revoke"
                      onClick={() => onRevoke(item)}
                    >
                      {labels.revoke}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <CopyButton text={item.ruleText} labels={labels} />
                  {/* A dismissed candidacy may be cleared for good — which
                      also frees the memory for a future candidacy. */}
                  {onDelete ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      data-testid="rule-delete"
                      onClick={() => onDelete(item)}
                    >
                      {labels.actions.delete}
                    </Button>
                  ) : null}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
