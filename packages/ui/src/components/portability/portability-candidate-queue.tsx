import * as React from 'react';

import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from '@workspace/ui/components/card';
import { cn } from '@workspace/ui/lib/utils';

/**
 * PortabilityCandidateQueue — the portability review queue: one card per
 * proposed project→core re-scope with the memory's content, the from→to
 * scopes, the judge's confidence, and the owner's approve / dismiss actions.
 * Mechanism only — every string arrives formatted from the caller so i18n
 * stays in the app; actions are delegated through `onResolve`.
 */

export type PortabilityCandidateAction = 'approve' | 'dismiss';

export interface PortabilityCandidateItem {
  id: string;
  status: 'pending' | 'approved' | 'dismissed';
  /** The memory proposed for the re-scope. */
  memoryHref: string;
  kind: string;
  content: string;
  fromScope: string;
  toScope: string;
  confidence: number | null;
  rationale: string | null;
}

export interface PortabilityCandidateQueueLabels {
  empty: string;
  confidence: string;
  approvedBadge: string;
  actions: {
    approve: string;
    dismiss: string;
  };
}

export function PortabilityCandidateQueue({
  items,
  labels,
  pendingId,
  onResolve,
  linkComponent: LinkComponent = 'a',
  className,
  ...props
}: React.ComponentPropsWithoutRef<'div'> & {
  items: PortabilityCandidateItem[];
  labels: PortabilityCandidateQueueLabels;
  /** Id whose action is in flight — its buttons render disabled. */
  pendingId?: string | null;
  onResolve?: (id: string, action: PortabilityCandidateAction) => void;
  /** Next.js Link (or any anchor-compatible component) for memory links. */
  linkComponent?: React.ElementType;
}) {
  if (items.length === 0) {
    return (
      <p
        className="text-muted-foreground rounded-xl border border-dashed p-6 text-sm"
        data-testid="portability-empty"
        {...props}
      >
        {labels.empty}
      </p>
    );
  }

  return (
    <div className={cn('space-y-4', className)} {...props}>
      {items.map((item) => (
        <Card key={item.id} data-testid="portability-candidate">
          <CardHeader className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" data-testid="portability-kind">
                {item.kind}
              </Badge>
              <Badge variant="outline" className="font-mono">
                {item.fromScope}
              </Badge>
              <span className="text-muted-foreground text-xs">→</span>
              <Badge variant="outline" className="font-mono">
                {item.toScope}
              </Badge>
              {item.confidence !== null ? (
                <span className="text-muted-foreground text-xs">
                  {labels.confidence} {Math.round(item.confidence * 100)}%
                </span>
              ) : null}
              {item.status === 'approved' ? (
                <Badge variant="secondary" data-testid="portability-approved">
                  {labels.approvedBadge}
                </Badge>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <LinkComponent
              href={item.memoryHref}
              className="hover:bg-secondary/40 block rounded-md px-2 py-1 text-base leading-relaxed whitespace-pre-wrap"
              data-testid="portability-content"
            >
              {item.content}
            </LinkComponent>
            {item.rationale ? (
              <p className="text-muted-foreground text-xs">{item.rationale}</p>
            ) : null}
          </CardContent>
          {item.status === 'pending' && onResolve ? (
            <CardFooter className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={pendingId === item.id}
                onClick={() => onResolve(item.id, 'approve')}
                data-testid="portability-approve"
              >
                {labels.actions.approve}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pendingId === item.id}
                onClick={() => onResolve(item.id, 'dismiss')}
                data-testid="portability-dismiss"
              >
                {labels.actions.dismiss}
              </Button>
            </CardFooter>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
