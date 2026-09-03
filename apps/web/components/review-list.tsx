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
  ReviewQueue,
  type ReviewItem,
  type ReviewQueueLabels,
  type ReviewResolutionKind,
} from '@workspace/ui/components/review/review-queue';

import { mergeConflict, resolveConflict } from '@/lib/review-actions';

export interface MergeDialogLabels {
  title: string;
  submit: string;
  submitPending: string;
  cancel: string;
}

export function ReviewList({
  items,
  labels,
  mergeLabels,
}: {
  items: ReviewItem[];
  labels: ReviewQueueLabels;
  mergeLabels: MergeDialogLabels;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [mergeItem, setMergeItem] = useState<ReviewItem | null>(null);
  const [mergeText, setMergeText] = useState('');

  function handleResolve(id: string, resolution: ReviewResolutionKind) {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) {
      return;
    }
    setError(null);
    setPendingId(id);
    startTransition(async () => {
      const result = await resolveConflict(
        id,
        resolution,
        item.memoryA.id,
        item.memoryB.id
      );
      setPendingId(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function openMerge(item: ReviewItem) {
    setError(null);
    setMergeItem(item);
    setMergeText(`${item.memoryA.content}\n\n${item.memoryB.content}`);
  }

  function submitMerge() {
    if (!mergeItem) {
      return;
    }
    const id = mergeItem.id;
    setPendingId(id);
    startTransition(async () => {
      const result = await mergeConflict(id, mergeText);
      setPendingId(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMergeItem(null);
      router.refresh();
    });
  }

  return (
    <>
      <ReviewQueue
        items={items}
        labels={labels}
        pendingId={pendingId}
        error={error}
        onResolve={handleResolve}
        onMerge={openMerge}
        linkComponent={Link}
      />

      <Dialog
        open={mergeItem !== null}
        onOpenChange={(open) => {
          if (!open) {
            setMergeItem(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{mergeLabels.title}</DialogTitle>
          </DialogHeader>
          <textarea
            data-testid="review-merge-text"
            className="min-h-40 w-full rounded-md border bg-transparent p-3 text-sm"
            value={mergeText}
            onChange={(event) => setMergeText(event.target.value)}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMergeItem(null)}>
              {mergeLabels.cancel}
            </Button>
            <Button
              data-testid="review-merge-submit"
              disabled={pendingId !== null || mergeText.trim() === ''}
              onClick={submitMerge}
            >
              {pendingId !== null
                ? mergeLabels.submitPending
                : mergeLabels.submit}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
