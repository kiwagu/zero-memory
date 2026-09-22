'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import {
  MemoryActions as MemoryActionsUi,
  type MemoryActionsLabels,
} from '@workspace/ui/components/memory/memory-actions';

import { forgetMemory, shareMemory } from '@/lib/actions';

export function MemoryActions({
  memoryId,
  invalidated,
  writableScopes,
  labels,
  onDone,
}: {
  memoryId: string;
  invalidated: boolean;
  writableScopes: string[];
  labels: MemoryActionsLabels;
  /** Replaces the page refresh after an action — a panel reloads itself. */
  onDone?: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleShare(scope: string) {
    setError(null);
    startTransition(async () => {
      const result = await shareMemory(memoryId, scope);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (onDone) {
        onDone();
      } else {
        router.refresh();
      }
    });
  }

  function handleForget() {
    setError(null);
    startTransition(async () => {
      const result = await forgetMemory(memoryId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (onDone) {
        onDone();
      } else {
        router.refresh();
      }
    });
  }

  return (
    <MemoryActionsUi
      labels={labels}
      writableScopes={writableScopes}
      invalidated={invalidated}
      pending={pending}
      error={error}
      onShare={handleShare}
      onForget={handleForget}
    />
  );
}
