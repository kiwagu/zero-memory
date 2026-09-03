'use client';

import * as React from 'react';

import { Button } from '@workspace/ui/components/button';
import { ConfirmDialog } from '@workspace/ui/components/common/confirm-dialog';
import { Input } from '@workspace/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components/select';

/**
 * MemoryActions — owner controls of a memory detail page: share into a scope
 * (writable scopes + a free-form custom scope) and a confirmed destructive
 * forget. Mechanism only: labels arrive translated, the actual mutations are
 * the injected `onShare`/`onForget` callbacks (the caller owns pending/error).
 */

const CUSTOM_SCOPE = '__custom__';

interface MemoryActionsLabels {
  share: string;
  shareTitle: string;
  customScopeOption: string;
  customScopePlaceholder: string;
  shareSubmit: string;
  shareSubmitPending: string;
  forget: string;
  forgetConfirmTitle: string;
  forgetConfirmDescription: string;
  forgetConfirm: string;
  cancel: string;
}

interface MemoryActionsProps {
  labels: MemoryActionsLabels;
  writableScopes: string[];
  invalidated: boolean;
  pending: boolean;
  error: string | null;
  onShare: (scope: string) => void;
  onForget: () => void;
}

function MemoryActions({
  labels,
  writableScopes,
  invalidated,
  pending,
  error,
  onShare,
  onForget,
}: MemoryActionsProps) {
  const [shareOpen, setShareOpen] = React.useState(false);
  const [forgetOpen, setForgetOpen] = React.useState(false);
  const [scope, setScope] = React.useState(writableScopes[0] ?? CUSTOM_SCOPE);
  const [customScope, setCustomScope] = React.useState('');

  const effectiveScope = scope === CUSTOM_SCOPE ? customScope.trim() : scope;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setShareOpen((open) => !open)}>
          {labels.share}
        </Button>
        {!invalidated ? (
          <Button
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() => setForgetOpen(true)}
          >
            {labels.forget}
          </Button>
        ) : null}
      </div>

      {shareOpen ? (
        <div className="space-y-2 rounded-lg border bg-muted/50 p-3">
          <p className="text-sm font-medium">{labels.shareTitle}</p>
          <Select
            value={scope}
            // Items map so Base UI's Select.Value shows labels, not raw values
            // (scopes are their own labels; the custom option is translated).
            items={{
              ...Object.fromEntries(
                writableScopes.map((writable) => [writable, writable])
              ),
              [CUSTOM_SCOPE]: labels.customScopeOption,
            }}
            onValueChange={(next) => setScope(String(next))}
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {writableScopes.map((writable) => (
                <SelectItem key={writable} value={writable}>
                  {writable}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_SCOPE}>
                {labels.customScopeOption}
              </SelectItem>
            </SelectContent>
          </Select>
          {scope === CUSTOM_SCOPE ? (
            <Input
              type="text"
              value={customScope}
              onChange={(event) => setCustomScope(event.target.value)}
              placeholder={labels.customScopePlaceholder}
            />
          ) : null}
          <Button
            size="sm"
            disabled={pending || !effectiveScope}
            onClick={() => onShare(effectiveScope)}
          >
            {pending ? labels.shareSubmitPending : labels.shareSubmit}
          </Button>
        </div>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <ConfirmDialog
        open={forgetOpen}
        onOpenChange={setForgetOpen}
        title={labels.forgetConfirmTitle}
        description={labels.forgetConfirmDescription}
        confirmLabel={labels.forgetConfirm}
        cancelLabel={labels.cancel}
        destructive
        busy={pending}
        onConfirm={() => {
          setForgetOpen(false);
          onForget();
        }}
      />
    </div>
  );
}

export { MemoryActions, type MemoryActionsLabels, type MemoryActionsProps };
