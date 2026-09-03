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
import { Switch } from '@workspace/ui/components/switch';
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
              <pre
                data-testid="rule-text"
                className="bg-muted rounded-md p-3 font-mono text-sm break-words whitespace-pre-wrap"
              >
                {item.ruleText}
              </pre>
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
              </div>
              {item.staleSignal ? (
                <Badge variant="amber" data-testid="rule-stale-signal">
                  {item.staleSignal}
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
