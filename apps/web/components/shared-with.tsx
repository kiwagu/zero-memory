'use client';

import { Share2 } from 'lucide-react';

import { Button } from '@workspace/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@workspace/ui/components/dialog';
import {
  MemberList,
  type MemberListItem,
} from '@workspace/ui/components/scope/member-list';

/**
 * A dedicated share-glyph button on the memory detail page that opens a dialog
 * listing who the memory's scope is shared with (members + roles). Kept off the
 * badge pill on purpose: the pill is a passive label, this is an explicit
 * affordance. Members arrive display-ready (email + role resolved server-side).
 */
export function SharedWith({
  members,
  youLabel,
  labels,
}: {
  members: MemberListItem[];
  youLabel: string;
  labels: { button: string; title: string; description: string; empty: string };
}) {
  return (
    <Dialog>
      <DialogTrigger
        render={<Button variant="ghost" size="icon-sm" />}
        data-testid="shared-with-trigger"
      >
        <Share2 className="size-4" aria-hidden />
        <span className="sr-only">{labels.button}</span>
      </DialogTrigger>
      <DialogContent data-testid="shared-with-dialog">
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription>{labels.description}</DialogDescription>
        </DialogHeader>
        {members.length > 0 ? (
          <MemberList items={members} youLabel={youLabel} />
        ) : (
          <p className="text-sm text-muted-foreground">{labels.empty}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
