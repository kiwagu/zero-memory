'use client';

import * as React from 'react';
import { Download, TriangleAlert } from 'lucide-react';

import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { Button } from '@workspace/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@workspace/ui/components/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';

export interface DeleteAccountLabels {
  title: string;
  description: string;
  /** The button that opens the confirmation dialog. */
  trigger: string;
  confirmTitle: string;
  /** The irreversible-deletion warning shown in the dialog. */
  warning: string;
  /** Copy above the export button, nudging a backup first. */
  exportHint: string;
  exportAction: string;
  /** Template with {value} — the exact string the user must type. */
  confirmPrompt: string;
  confirmPlaceholder: string;
  cancel: string;
  confirm: string;
  deleting: string;
}

export type DeleteAccountPanelProps = {
  labels: DeleteAccountLabels;
  /** The exact string the user must type to arm the delete button (their email). */
  confirmationValue: string;
  /** Starts a data export (data portability) — offered, never required. */
  onExport: () => void;
  /**
   * Runs the irreversible deletion. On `ok` the caller navigates away (the
   * account no longer exists); on failure the returned message is surfaced and
   * the dialog stays open.
   */
  onDelete: () => Promise<{ ok: true } | { ok: false; error: string }>;
};

/**
 * DeleteAccountPanel — the account "danger zone": erase this account and every
 * record it owns.
 *
 * The action is guarded two ways, because it is irreversible: it lives behind a
 * modal, and the confirm button stays disabled until the user retypes their own
 * email. Data portability is offered inside the modal (an export button), but
 * never forced — the user decides whether to keep a copy. Mechanism only; all
 * copy is passed in and the actual work is the caller's `onExport`/`onDelete`.
 */
export function DeleteAccountPanel({
  labels,
  confirmationValue,
  onExport,
  onDelete,
}: DeleteAccountPanelProps) {
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Case-insensitive so a capitalized email still matches; the user must still
  // reproduce their own address exactly otherwise.
  const armed =
    typed.trim().toLowerCase() === confirmationValue.trim().toLowerCase() &&
    confirmationValue.trim() !== '';

  const reset = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setTyped('');
      setError(null);
    }
  };

  const runDelete = async () => {
    setBusy(true);
    setError(null);
    const result = await onDelete();
    if (!result.ok) {
      setBusy(false);
      setError(result.error);
      return;
    }
    // Leave `busy` set: on success the caller redirects out of the app, so the
    // button must not re-enable in the interval before navigation.
  };

  return (
    <Card
      className="border-destructive/40"
      data-testid="settings-delete-account"
    >
      <CardHeader>
        <CardTitle className="text-destructive flex items-center gap-2">
          <TriangleAlert className="size-4" /> {labels.title}
        </CardTitle>
        <CardDescription>{labels.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="destructive"
          onClick={() => reset(true)}
          data-testid="settings-delete-account-open"
        >
          {labels.trigger}
        </Button>
      </CardContent>

      <Dialog open={open} onOpenChange={reset}>
        <DialogContent data-testid="settings-delete-account-dialog">
          <DialogHeader>
            <DialogTitle className="text-destructive flex items-center gap-2">
              <TriangleAlert className="size-4" /> {labels.confirmTitle}
            </DialogTitle>
            <DialogDescription>{labels.warning}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-muted-foreground text-sm">
                {labels.exportHint}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={onExport}
                data-testid="settings-delete-account-export"
              >
                <Download className="size-4" />
                {labels.exportAction}
              </Button>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="delete-account-confirm">
                {labels.confirmPrompt.replace('{value}', confirmationValue)}
              </Label>
              <Input
                id="delete-account-confirm"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                placeholder={labels.confirmPlaceholder}
                onChange={(event) => setTyped(event.target.value)}
                data-testid="settings-delete-account-input"
              />
            </div>

            {error ? (
              <Alert
                variant="destructive"
                data-testid="settings-delete-account-error"
              >
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>
              {labels.cancel}
            </DialogClose>
            <Button
              variant="destructive"
              disabled={!armed || busy}
              onClick={() => void runDelete()}
              data-testid="settings-delete-account-confirm"
            >
              {busy ? labels.deleting : labels.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
