'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import {
  PortabilityCandidateQueue,
  type PortabilityCandidateAction,
  type PortabilityCandidateItem,
  type PortabilityCandidateQueueLabels,
} from '@workspace/ui/components/portability/portability-candidate-queue';

import { resolvePortabilityCandidate } from '@/lib/portability.actions';

export function PortabilityCandidateList({
  items,
  labels,
}: {
  items: PortabilityCandidateItem[];
  labels: PortabilityCandidateQueueLabels;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function handleResolve(id: string, action: PortabilityCandidateAction) {
    setError(null);
    setPendingId(id);
    startTransition(async () => {
      const result = await resolvePortabilityCandidate(id, action);
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
        <p className="text-destructive text-sm" data-testid="portability-error">
          {error}
        </p>
      ) : null}
      <PortabilityCandidateQueue
        items={items}
        labels={labels}
        pendingId={pendingId}
        onResolve={handleResolve}
        linkComponent={Link}
      />
    </div>
  );
}
