import * as React from 'react';

import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@workspace/ui/components/card';
import { cn } from '@workspace/ui/lib/utils';

/**
 * ReflectionCandidateQueue — the reflection review queue: one card per
 * episode cluster with the distilled consolidated-fact draft, its source
 * episodes, and the owner's approve / dismiss / snooze actions. Mechanism
 * only — every string arrives formatted from the caller so i18n stays in the
 * app; actions are delegated through `onResolve`.
 */

export type ReflectionCandidateAction = 'approve' | 'dismiss' | 'snooze';

export interface ReflectionMemberItem {
  id: string;
  /** Link to the episode's memory detail page. */
  href: string;
  /** Preformatted date stamp. */
  when: string;
  /** Truncated content preview. */
  preview: string;
}

export interface ReflectionCandidateItem {
  id: string;
  status: 'pending' | 'approved' | 'dismissed' | 'snoozed';
  /** The distilled consolidated-fact draft. */
  content: string;
  /** Proposed kind of the consolidated memory (fact / convention). */
  kind: string;
  scope: string;
  confidence: number | null;
  rationale: string | null;
  members: ReflectionMemberItem[];
  /** Set on approved rows: the written consolidated memory. */
  approvedMemoryHref?: string;
}

export interface ReflectionCandidateQueueLabels {
  empty: string;
  confidence: string;
  sources: string;
  approvedBadge: string;
  approvedMemory: string;
  actions: {
    approve: string;
    dismiss: string;
    snooze: string;
  };
}

export function ReflectionCandidateQueue({
  items,
  labels,
  pendingId,
  onResolve,
  linkComponent: LinkComponent = 'a',
  className,
  ...props
}: React.ComponentPropsWithoutRef<'div'> & {
  items: ReflectionCandidateItem[];
  labels: ReflectionCandidateQueueLabels;
  /** Id whose action is in flight — its buttons render disabled. */
  pendingId?: string | null;
  onResolve?: (id: string, action: ReflectionCandidateAction) => void;
  /** Next.js Link (or any anchor-compatible component) for member links. */
  linkComponent?: React.ElementType;
}) {
  if (items.length === 0) {
    return (
      <p
        className="text-muted-foreground rounded-xl border border-dashed p-6 text-sm"
        data-testid="reflections-empty"
        {...props}
      >
        {labels.empty}
      </p>
    );
  }

  return (
    <div className={cn('space-y-4', className)} {...props}>
      {items.map((item) => (
        <Card key={item.id} data-testid="reflection-candidate">
          <CardHeader className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" data-testid="reflection-kind">
                {item.kind}
              </Badge>
              <Badge variant="outline" className="font-mono">
                {item.scope}
              </Badge>
              {item.confidence !== null ? (
                <span className="text-muted-foreground text-xs">
                  {labels.confidence} {Math.round(item.confidence * 100)}%
                </span>
              ) : null}
              {item.status === 'approved' ? (
                <Badge variant="secondary" data-testid="reflection-approved">
                  {labels.approvedBadge}
                </Badge>
              ) : null}
            </div>
            <CardTitle
              className="text-base leading-relaxed font-normal whitespace-pre-wrap"
              data-testid="reflection-draft"
            >
              {item.content}
            </CardTitle>
            {item.rationale ? (
              <p className="text-muted-foreground text-xs">{item.rationale}</p>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-muted-foreground text-xs font-medium">
              {labels.sources}
            </p>
            <ul className="space-y-1" data-testid="reflection-members">
              {item.members.map((member) => (
                <li key={member.id} className="text-sm">
                  <LinkComponent
                    href={member.href}
                    className="hover:bg-secondary/40 block rounded-md px-2 py-1"
                  >
                    <span className="text-muted-foreground mr-2 text-xs tabular-nums">
                      {member.when}
                    </span>
                    {member.preview}
                  </LinkComponent>
                </li>
              ))}
            </ul>
            {item.approvedMemoryHref ? (
              <LinkComponent
                href={item.approvedMemoryHref}
                className="text-sm underline underline-offset-4"
                data-testid="reflection-approved-link"
              >
                {labels.approvedMemory}
              </LinkComponent>
            ) : null}
          </CardContent>
          {item.status === 'pending' && onResolve ? (
            <CardFooter className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={pendingId === item.id}
                onClick={() => onResolve(item.id, 'approve')}
                data-testid="reflection-approve"
              >
                {labels.actions.approve}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pendingId === item.id}
                onClick={() => onResolve(item.id, 'dismiss')}
                data-testid="reflection-dismiss"
              >
                {labels.actions.dismiss}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pendingId === item.id}
                onClick={() => onResolve(item.id, 'snooze')}
                data-testid="reflection-snooze"
              >
                {labels.actions.snooze}
              </Button>
            </CardFooter>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
