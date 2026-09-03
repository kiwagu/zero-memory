'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@workspace/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@workspace/ui/components/dialog';
import {
  RuleCandidateQueue,
  type RuleCandidateAction,
  type RuleAddressingChoice,
  type RuleCandidateItem,
  type RuleCandidateQueueLabels,
} from '@workspace/ui/components/rules/rule-candidate-queue';

import { ConfirmDialog } from '@workspace/ui/components/common/confirm-dialog';

import {
  deleteRuleCandidate,
  resolveRuleCandidate,
  revokeRuleCandidate,
  setRulePinned,
} from '@/lib/rule-candidate.actions';

export interface RevokeDialogLabels {
  title: string;
  description: string;
  reasonLabel: string;
  reasonPlaceholder: string;
  submit: string;
  submitPending: string;
  cancel: string;
}

export interface DeleteDialogLabels {
  title: string;
  description: string;
  confirm: string;
  cancel: string;
}

export function RuleCandidateList({
  items,
  labels,
  revokeLabels,
  deleteLabels,
}: {
  items: RuleCandidateItem[];
  labels: RuleCandidateQueueLabels;
  revokeLabels: RevokeDialogLabels;
  deleteLabels: DeleteDialogLabels;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [revokeItem, setRevokeItem] = useState<RuleCandidateItem | null>(null);
  const [deleteItem, setDeleteItem] = useState<RuleCandidateItem | null>(null);
  const [reason, setReason] = useState('');

  function handleResolve(
    id: string,
    action: RuleCandidateAction,
    addressing?: RuleAddressingChoice
  ) {
    setError(null);
    setPendingId(id);
    startTransition(async () => {
      const result = await resolveRuleCandidate(id, action, addressing);
      setPendingId(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function handleTogglePin(item: RuleCandidateItem, pinned: boolean) {
    setError(null);
    setPendingId(item.id);
    startTransition(async () => {
      const result = await setRulePinned(item.id, pinned);
      setPendingId(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function openRevoke(item: RuleCandidateItem) {
    setError(null);
    setReason('');
    setRevokeItem(item);
  }

  function submitRevoke() {
    if (!revokeItem) {
      return;
    }
    const id = revokeItem.id;
    setPendingId(id);
    startTransition(async () => {
      const result = await revokeRuleCandidate(id, reason);
      setPendingId(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRevokeItem(null);
      router.refresh();
    });
  }

  function submitDelete() {
    if (!deleteItem) {
      return;
    }
    const id = deleteItem.id;
    setPendingId(id);
    startTransition(async () => {
      const result = await deleteRuleCandidate(id);
      setPendingId(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDeleteItem(null);
      router.refresh();
    });
  }

  return (
    <>
      <RuleCandidateQueue
        items={items}
        labels={labels}
        pendingId={pendingId}
        error={error}
        onResolve={handleResolve}
        onRevoke={openRevoke}
        onTogglePin={handleTogglePin}
        onDelete={(item) => {
          setError(null);
          setDeleteItem(item);
        }}
        linkComponent={Link}
      />

      <ConfirmDialog
        open={deleteItem !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteItem(null);
          }
        }}
        title={deleteLabels.title}
        description={deleteLabels.description}
        confirmLabel={deleteLabels.confirm}
        cancelLabel={deleteLabels.cancel}
        busy={pendingId !== null}
        destructive
        onConfirm={submitDelete}
      />

      <Dialog
        open={revokeItem !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevokeItem(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{revokeLabels.title}</DialogTitle>
          </DialogHeader>
          <p className="text-muted-foreground text-sm">
            {revokeLabels.description}
          </p>
          <label className="text-sm font-medium" htmlFor="rule-revoke-reason">
            {revokeLabels.reasonLabel}
          </label>
          <textarea
            id="rule-revoke-reason"
            data-testid="rule-revoke-reason"
            className="min-h-24 w-full rounded-md border bg-transparent p-3 text-sm"
            placeholder={revokeLabels.reasonPlaceholder}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevokeItem(null)}>
              {revokeLabels.cancel}
            </Button>
            <Button
              variant="destructive"
              data-testid="rule-revoke-submit"
              disabled={pendingId !== null || reason.trim() === ''}
              onClick={submitRevoke}
            >
              {pendingId !== null
                ? revokeLabels.submitPending
                : revokeLabels.submit}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
