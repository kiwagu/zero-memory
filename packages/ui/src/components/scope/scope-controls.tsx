'use client';

import * as React from 'react';
import { MoreHorizontal, Sparkles } from 'lucide-react';

import { Button } from '@workspace/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@workspace/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Input } from '@workspace/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components/select';
import { Textarea } from '@workspace/ui/components/textarea';

/**
 * ScopeControls — the admin menu of one scope card: edit metadata (alias +
 * description), rename the slug, merge into another scope, delete. Pure
 * mechanism: all copy arrives translated, every effect is an injected
 * handler resolving to an error message or null. Deleting is framed as the
 * destructive last resort — the delete dialog offers merging as the
 * loss-free alternative and can switch straight to the merge dialog.
 */

export interface ScopeControlsLabels {
  menu: string;
  editMeta: string;
  rename: string;
  merge: string;
  delete: string;
  metaTitle: string;
  aliasLabel: string;
  aliasPlaceholder: string;
  descriptionLabel: string;
  descriptionPlaceholder: string;
  generate: string;
  generatePending: string;
  renameTitle: string;
  renameHint: string;
  mergeTitle: string;
  mergeBody: string;
  mergeTargetPlaceholder: string;
  deleteTitle: string;
  deleteBody: string;
  deleteAlternative: string;
  save: string;
  confirm: string;
  cancel: string;
  pending: string;
}

export interface ScopeControlsHandlers {
  saveMeta: (alias: string, description: string) => Promise<string | null>;
  rename: (slug: string) => Promise<string | null>;
  merge: (into: string) => Promise<string | null>;
  remove: () => Promise<string | null>;
  /** Optional model-written description; resolves to the generated text. */
  generateDescription?: () => Promise<
    { description: string } | { error: string }
  >;
}

export interface MergeTargetOption {
  value: string;
  label: string;
}

type OpenDialog = 'meta' | 'rename' | 'merge' | 'delete' | null;

export function ScopeControls({
  scope,
  alias,
  description,
  mergeTargets,
  labels,
  handlers,
}: {
  scope: string;
  alias: string | null;
  description: string | null;
  mergeTargets: MergeTargetOption[];
  labels: ScopeControlsLabels;
  handlers: ScopeControlsHandlers;
}) {
  const [open, setOpen] = React.useState<OpenDialog>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const slug = scope.split('.').at(-1) ?? scope;
  const prefix = scope.slice(0, scope.length - slug.length);
  const [aliasDraft, setAliasDraft] = React.useState(alias ?? '');
  const [descriptionDraft, setDescriptionDraft] = React.useState(
    description ?? ''
  );
  const [slugDraft, setSlugDraft] = React.useState(slug);
  const [mergeTarget, setMergeTarget] = React.useState('');

  function openDialog(dialog: Exclude<OpenDialog, null>) {
    setError(null);
    setAliasDraft(alias ?? '');
    setDescriptionDraft(description ?? '');
    setSlugDraft(slug);
    setMergeTarget('');
    setOpen(dialog);
  }

  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    const failure = await action();
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setOpen(null);
  }

  async function generate() {
    if (!handlers.generateDescription) {
      return;
    }
    setBusy(true);
    setError(null);
    const result = await handlers.generateDescription();
    setBusy(false);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setDescriptionDraft(result.description);
  }

  const errorLine = error ? (
    <p className="text-destructive text-sm" role="alert">
      {error}
    </p>
  ) : null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label={labels.menu}
              data-testid="scope-controls-trigger"
            >
              <MoreHorizontal />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => openDialog('meta')}>
            {labels.editMeta}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openDialog('rename')}>
            {labels.rename}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={mergeTargets.length === 0}
            onClick={() => openDialog('merge')}
          >
            {labels.merge}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            data-testid="scope-delete-item"
            onClick={() => openDialog('delete')}
          >
            {labels.delete}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Edit metadata: alias + description (model-generatable). */}
      <Dialog
        open={open === 'meta'}
        onOpenChange={(next) => (next ? undefined : setOpen(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{labels.metaTitle}</DialogTitle>
            <DialogDescription className="font-mono break-all">
              {scope}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">{labels.aliasLabel}</label>
              <Input
                value={aliasDraft}
                maxLength={64}
                placeholder={labels.aliasPlaceholder}
                onChange={(event) => setAliasDraft(event.target.value)}
                data-testid="scope-alias-input"
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">
                  {labels.descriptionLabel}
                </label>
                {handlers.generateDescription ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={generate}
                    data-testid="scope-generate-description"
                  >
                    <Sparkles />
                    {busy ? labels.generatePending : labels.generate}
                  </Button>
                ) : null}
              </div>
              <Textarea
                value={descriptionDraft}
                maxLength={2000}
                rows={4}
                placeholder={labels.descriptionPlaceholder}
                onChange={(event) => setDescriptionDraft(event.target.value)}
                data-testid="scope-description-input"
              />
            </div>
            {errorLine}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>
              {labels.cancel}
            </DialogClose>
            <Button
              disabled={busy}
              onClick={() =>
                run(() => handlers.saveMeta(aliasDraft, descriptionDraft))
              }
              data-testid="scope-meta-save"
            >
              {busy ? labels.pending : labels.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename: only the slug changes, the per-owner prefix stays. */}
      <Dialog
        open={open === 'rename'}
        onOpenChange={(next) => (next ? undefined : setOpen(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{labels.renameTitle}</DialogTitle>
            <DialogDescription>{labels.renameHint}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground max-w-40 truncate font-mono text-xs">
                {prefix}
              </span>
              <Input
                value={slugDraft}
                onChange={(event) => setSlugDraft(event.target.value)}
                data-testid="scope-rename-input"
              />
            </div>
            {errorLine}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>
              {labels.cancel}
            </DialogClose>
            <Button
              disabled={busy || slugDraft.trim() === ''}
              onClick={() => run(() => handlers.rename(slugDraft.trim()))}
              data-testid="scope-rename-confirm"
            >
              {busy ? labels.pending : labels.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Merge: pour this scope into another one (loss-free). */}
      <Dialog
        open={open === 'merge'}
        onOpenChange={(next) => (next ? undefined : setOpen(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{labels.mergeTitle}</DialogTitle>
            <DialogDescription>{labels.mergeBody}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Select
              value={mergeTarget}
              items={Object.fromEntries(
                mergeTargets.map((target) => [target.value, target.label])
              )}
              onValueChange={(next) => setMergeTarget(String(next ?? ''))}
            >
              <SelectTrigger
                className="w-full [&>span]:truncate"
                data-testid="scope-merge-target"
              >
                <SelectValue placeholder={labels.mergeTargetPlaceholder} />
              </SelectTrigger>
              <SelectContent className="w-max min-w-(--anchor-width) max-w-96">
                {mergeTargets.map((target) => (
                  <SelectItem key={target.value} value={target.value}>
                    <span
                      className="block max-w-80 truncate"
                      title={target.value}
                    >
                      {target.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errorLine}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>
              {labels.cancel}
            </DialogClose>
            <Button
              disabled={busy || !mergeTarget}
              onClick={() => run(() => handlers.merge(mergeTarget))}
              data-testid="scope-merge-confirm"
            >
              {busy ? labels.pending : labels.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete: destructive, with merge offered as the alternative. */}
      <Dialog
        open={open === 'delete'}
        onOpenChange={(next) => (next ? undefined : setOpen(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{labels.deleteTitle}</DialogTitle>
            <DialogDescription>{labels.deleteBody}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {mergeTargets.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => openDialog('merge')}
                data-testid="scope-delete-merge-instead"
              >
                {labels.deleteAlternative}
              </Button>
            ) : null}
            {errorLine}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>
              {labels.cancel}
            </DialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => run(() => handlers.remove())}
              data-testid="scope-delete-confirm"
            >
              {busy ? labels.pending : labels.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
