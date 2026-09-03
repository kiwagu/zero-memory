'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';

import { Button } from '@workspace/ui/components/button';
import { ConfirmDialog } from '@workspace/ui/components/common/confirm-dialog';

export interface ScopeExportLabels {
  label: string;
  title: string;
  confirmTitle: string;
  confirmBody: string;
  confirm: string;
  cancel: string;
}

/**
 * Per-scope export trigger. Because a scope export carries potentially
 * sensitive memory out of the database, it is gated behind an explicit
 * confirmation: the download only fires once the user accepts that the leak
 * risk is theirs. Thin wrapper — presentation is the shared Button/ConfirmDialog.
 */
export function ScopeExportButton({
  scope,
  labels,
}: {
  scope: string;
  labels: ScopeExportLabels;
}) {
  const [open, setOpen] = useState(false);
  const href = `/settings/export?scope=${encodeURIComponent(scope)}`;

  function confirmDownload() {
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = '';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setOpen(false);
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        title={labels.title}
        data-testid="scope-export"
        className="text-muted-foreground hover:text-foreground h-auto gap-1 px-2 py-1 text-xs"
      >
        <Download className="size-3.5" />
        {labels.label}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={labels.confirmTitle}
        description={labels.confirmBody}
        confirmLabel={labels.confirm}
        cancelLabel={labels.cancel}
        onConfirm={confirmDownload}
      />
    </>
  );
}
