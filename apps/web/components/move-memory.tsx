'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@workspace/ui/components/button';
import { ConfirmDialog } from '@workspace/ui/components/common/confirm-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components/select';

import { moveMemoryToScope } from '@/lib/memory-move.actions';

export interface MoveMemoryLabels {
  move: string;
  title: string;
  description: string;
  targetPlaceholder: string;
  confirm: string;
  cancel: string;
  done: string;
}

/**
 * Manual re-scope from the memory detail page: the owner moves THIS memory
 * into the project it belongs to. Always visible for an owned, valid memory —
 * the standing UI instrument of the migration story (the batch modal on the
 * feed only appears when stamped fallbacks are pending).
 */
export function MoveMemory({
  memoryId,
  currentScope,
  projectScopes,
  labels,
}: {
  memoryId: string;
  currentScope: string;
  projectScopes: Array<{ value: string; label: string }>;
  labels: MoveMemoryLabels;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Nowhere to move: the only project scope is the one it is already in.
  // A just-completed move usually CAUSES that state (the memory now lives in
  // the scope it was moved to), so the done note must outlive it — otherwise
  // the confirmation disappears at the moment it is earned.
  const targets = projectScopes.filter((scope) => scope.value !== currentScope);
  if (targets.length === 0 && !done) {
    return null;
  }

  function handleConfirm() {
    if (!target) return;
    setError(null);
    startTransition(async () => {
      const result = await moveMemoryToScope(memoryId, target);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone(true);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      {targets.length > 0 ? (
        <Button
          variant="outline"
          size="sm"
          data-testid="memory-move"
          onClick={() => setOpen(true)}
        >
          {labels.move}
        </Button>
      ) : null}
      {done ? (
        <span
          className="text-muted-foreground text-sm"
          data-testid="memory-move-done"
        >
          {labels.done}
        </span>
      ) : null}
      {error ? <span className="text-destructive text-sm">{error}</span> : null}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={labels.title}
        description={
          // The dialog renders its description INSIDE a <p>, so this subtree
          // must stay phrasing content — block-level tags here nest <p> in
          // <p> and break hydration. Spans made block-level carry the layout.
          <span className="block space-y-3">
            <span className="block">{labels.description}</span>
            <Select value={target ?? ''} onValueChange={setTarget}>
              <SelectTrigger data-testid="memory-move-target">
                <SelectValue placeholder={labels.targetPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {targets.map((scope) => (
                  <SelectItem key={scope.value} value={scope.value}>
                    {scope.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </span>
        }
        confirmLabel={labels.confirm}
        cancelLabel={labels.cancel}
        onConfirm={handleConfirm}
        busy={pending || !target}
      />
    </div>
  );
}
