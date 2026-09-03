'use client';

import * as React from 'react';

import { cn } from '@workspace/ui/lib/utils';

/** Reads all entries from a directory reader, which returns them in batches. */
function readAllEntries(
  reader: FileSystemDirectoryReader
): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const pump = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        pump();
      }, reject);
    };
    pump();
  });
}

/** Recursively collects every File under a dropped file/directory entry. */
async function walkEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject)
    );
    return [file];
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const entries = await readAllEntries(reader);
    const nested = await Promise.all(entries.map(walkEntry));
    return nested.flat();
  }
  return [];
}

/**
 * A generic file drop target: drag-and-drop (recursing into dropped folders),
 * or click to browse. Emits the raw `File[]`; the caller owns what to do with
 * them. Vendor-neutral — all copy passed in, no domain knowledge.
 */
export function Dropzone({
  onFiles,
  accept,
  disabled = false,
  labels,
  icon,
  testId,
  className,
}: {
  onFiles: (files: File[]) => void;
  /** `accept` attribute for the click-to-browse input (e.g. ".md,.zip"). */
  accept?: string;
  disabled?: boolean;
  labels: { hint: React.ReactNode; browse: React.ReactNode };
  /** Leading glyph shown in the target. */
  icon?: React.ReactNode;
  testId?: string;
  className?: string;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);

  async function onDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (disabled) {
      return;
    }
    const items = Array.from(event.dataTransfer.items)
      .map((item) => item.webkitGetAsEntry())
      .filter((entry): entry is FileSystemEntry => entry !== null);
    if (items.length > 0) {
      const nested = await Promise.all(items.map(walkEntry));
      onFiles(nested.flat());
      return;
    }
    onFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <>
      <div
        data-testid={testId}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !disabled && inputRef.current?.click()}
        className={cn(
          'flex min-h-28 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-center text-sm transition-colors',
          disabled
            ? 'border-foreground/20 cursor-default opacity-60'
            : dragging
              ? 'border-primary bg-primary/5 cursor-pointer'
              : 'border-foreground/20 hover:border-foreground/40 cursor-pointer',
          className
        )}
      >
        {icon}
        <span className="text-muted-foreground">{labels.hint}</span>
        <span className="text-primary text-xs">{labels.browse}</span>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        className="hidden"
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
    </>
  );
}
