'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { UserMinus } from 'lucide-react';

import { Button } from '@workspace/ui/components/button';
import { ConfirmDialog } from '@workspace/ui/components/common/confirm-dialog';

import { removeScopeMember } from '@/lib/actions';

export interface RemoveMemberLabels {
  button: string;
  confirmTitle: string;
  confirmBody: string;
  confirm: string;
  cancel: string;
}

/**
 * Per-member revoke control on a scope card (admin-only, never for yourself).
 * A destructive confirm guards the delete; on success the page revalidates so
 * the member row disappears. An error is surfaced inline next to the button.
 */
export function RemoveMemberButton({
  scope,
  userId,
  labels,
}: {
  scope: string;
  userId: string;
  labels: RemoveMemberLabels;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirmRemove() {
    setError(null);
    startTransition(async () => {
      const result = await removeScopeMember(scope, userId);
      if (!result.ok) {
        setError(result.error);
        setOpen(false);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setOpen(true)}
        title={labels.button}
        data-testid="scope-member-remove"
        className="text-muted-foreground hover:text-destructive"
      >
        <UserMinus className="size-3.5" aria-hidden />
        <span className="sr-only">{labels.button}</span>
      </Button>
      {error ? (
        <span className="text-destructive text-xs" role="alert">
          {error}
        </span>
      ) : null}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={labels.confirmTitle}
        description={labels.confirmBody}
        confirmLabel={labels.confirm}
        cancelLabel={labels.cancel}
        onConfirm={confirmRemove}
        busy={pending}
        destructive
      />
    </>
  );
}
