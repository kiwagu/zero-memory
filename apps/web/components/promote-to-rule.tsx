'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@workspace/ui/components/button';

import { promoteMemoryToRule } from '@/lib/rule-candidate.actions';

export interface PromoteToRuleLabels {
  promote: string;
  pending: string;
  done: string;
  /** Shown when the memory was earlier dismissed as a rule. */
  promoteAnyway: string;
}

/**
 * Owner-only "Promote to rule" action on the memory detail page. Turns the
 * memory into a promoted rule via the LLM-free definer RPC. Because MCP
 * `instructions` are captured at session initialize, a freshly promoted rule
 * reaches NEW sessions — the done state says so.
 */
export function PromoteToRule({
  memoryId,
  labels,
}: {
  memoryId: string;
  labels: PromoteToRuleLabels;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [needsForce, setNeedsForce] = useState(false);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  function handlePromote(force = false) {
    setError(null);
    startTransition(async () => {
      const result = await promoteMemoryToRule(memoryId, force);
      if (!result.ok) {
        setError(result.error);
        // A dismissed candidacy is only revived on an explicit second click.
        setNeedsForce(Boolean(result.dismissed));
        return;
      }
      setDone(true);
      router.refresh();
    });
  }

  if (done) {
    return (
      <p
        data-testid="promote-to-rule-done"
        className="text-sm text-muted-foreground"
      >
        {labels.done}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => handlePromote(needsForce)}
        data-testid={needsForce ? 'promote-to-rule-force' : 'promote-to-rule'}
        className="self-start"
      >
        {pending
          ? labels.pending
          : needsForce
            ? labels.promoteAnyway
            : labels.promote}
      </Button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
