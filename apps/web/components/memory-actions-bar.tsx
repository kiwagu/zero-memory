'use client';

import { MemoryActions } from '@/components/memory-actions';
import { MoveMemory } from '@/components/move-memory';
import { PromoteToRule } from '@/components/promote-to-rule';
import type { MemoryActionsData } from '@/lib/views/memory.view';

/**
 * The owner's actions on one memory, in the order the page has always shown
 * them: promote and move while the memory is valid, then share/forget. `onDone`
 * lets a panel reload itself after an action instead of the page refreshing.
 */
export function MemoryActionsBar({
  memoryId,
  invalidated,
  currentScope,
  moveTargets,
  writableScopes,
  labels,
  onDone,
}: MemoryActionsData & { onDone?: () => void }) {
  return (
    <>
      {!invalidated ? (
        <PromoteToRule
          memoryId={memoryId}
          labels={labels.promote}
          onDone={onDone}
        />
      ) : null}
      {!invalidated ? (
        <MoveMemory
          memoryId={memoryId}
          currentScope={currentScope}
          projectScopes={moveTargets}
          labels={labels.move}
          onDone={onDone}
        />
      ) : null}
      <MemoryActions
        memoryId={memoryId}
        invalidated={invalidated}
        writableScopes={writableScopes}
        labels={labels.actions}
        onDone={onDone}
      />
    </>
  );
}
