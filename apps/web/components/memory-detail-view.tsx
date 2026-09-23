import Link from 'next/link';
import type * as React from 'react';

import { MemoryDetail } from '@workspace/ui/components/memory/memory-detail';

import { MemoryActionsBar } from '@/components/memory-actions-bar';
import { SharedWith } from '@/components/shared-with';
import type { MemoryViewData } from '@/lib/views/memory.view';

/**
 * One memory, the same on its page and in a panel of the chain. No hooks and
 * no directive: the page renders it on the server, a panel renders it on the
 * client, and the owner's actions and the sharing readout are client islands
 * either way.
 */
export function MemoryDetailView({
  view,
  header,
  onDone,
  linkComponent = Link,
}: {
  view: MemoryViewData;
  header?: React.ReactNode;
  onDone?: () => void;
  linkComponent?: React.ElementType;
}) {
  return (
    <MemoryDetail
      {...view.detail}
      linkComponent={linkComponent}
      header={header}
      badgesAside={view.sharing ? <SharedWith {...view.sharing} /> : null}
      actions={
        view.actions ? (
          <MemoryActionsBar {...view.actions} onDone={onDone} />
        ) : null
      }
    />
  );
}
