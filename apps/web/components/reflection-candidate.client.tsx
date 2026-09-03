'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import {
  ReflectionCandidateQueue,
  type ReflectionCandidateAction,
  type ReflectionCandidateItem,
  type ReflectionCandidateQueueLabels,
} from '@workspace/ui/components/reflections/reflection-candidate-queue';

import { resolveReflectionCandidate } from '@/lib/reflection.actions';

export function ReflectionCandidateList({
  items,
  labels,
}: {
  items: ReflectionCandidateItem[];
  labels: ReflectionCandidateQueueLabels;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function handleResolve(id: string, action: ReflectionCandidateAction) {
    setError(null);
    setPendingId(id);
    startTransition(async () => {
      const result = await resolveReflectionCandidate(id, action);
      setPendingId(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {error ? (
        <p className="text-destructive text-sm" data-testid="reflection-error">
          {error}
        </p>
      ) : null}
      <ReflectionCandidateQueue
        items={items}
        labels={labels}
        pendingId={pendingId}
        onResolve={handleResolve}
        linkComponent={Link}
      />
    </div>
  );
}
