'use client';

import {
  MemoryTransferPanel,
  type MemoryTransferLabels,
  type MemoryTransferSummary,
} from '@workspace/ui/components/settings/memory-transfer-panel';

import { importMemories, type DroppedFile } from '@/lib/settings-actions';
import { readZip } from '@/lib/unzip';

/** Files per import round-trip: small enough that the bar advances smoothly. */
const IMPORT_BATCH = 25;

const isMarkdown = (name: string): boolean =>
  name.endsWith('.md') || name.endsWith('.markdown');

const isZip = (name: string): boolean => name.toLowerCase().endsWith('.zip');

/**
 * Normalizes dropped files into importable memory files: Markdown files are read
 * as-is; a `.zip` (the export archive) is unpacked in the browser and its
 * Markdown entries pulled out. Anything else is ignored.
 */
async function collectDropped(files: File[]): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  for (const file of files) {
    if (isZip(file.name)) {
      const entries = await readZip(new Uint8Array(await file.arrayBuffer()));
      for (const entry of entries) {
        if (isMarkdown(entry.path)) {
          out.push(entry);
        }
      }
    } else if (isMarkdown(file.name)) {
      out.push({
        // webkitRelativePath is set for folder picks; fall back to the name.
        path: file.webkitRelativePath || file.name,
        content: await file.text(),
      });
    }
  }
  return out;
}

/**
 * Thin infrastructure wrapper around the vendor-neutral {@link MemoryTransferPanel}:
 * wires the streamed export download and the batched, idempotent import (through
 * the server action) into the presentational panel via callbacks.
 */
export function SettingsMemoryPanel({
  labels,
}: {
  labels: MemoryTransferLabels;
}) {
  /** Streams the export, reporting download progress against Content-Length. */
  async function handleExport(report: (pct: number | null) => void) {
    const res = await fetch('/settings/export');
    if (!res.ok || !res.body) {
      throw new Error(await res.text());
    }
    const total = Number(res.headers.get('content-length')) || 0;
    const filename =
      res.headers.get('content-disposition')?.match(/filename="(.+?)"/)?.[1] ??
      'zm-memory-export.zip';

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      report(total ? Math.round((received / total) * 100) : null);
    }

    const url = URL.createObjectURL(
      new Blob(chunks as BlobPart[], { type: 'application/zip' })
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  /** Imports dropped files in sequential batches, reporting per-batch progress. */
  async function handleImport(
    files: File[],
    report: (done: number, total: number) => void
  ): Promise<MemoryTransferSummary | null> {
    const dropped = await collectDropped(files);
    if (dropped.length === 0) {
      return null;
    }
    report(0, dropped.length);

    const merged: MemoryTransferSummary = {
      ok: true,
      imported: 0,
      unchanged: 0,
      failed: [],
    };
    for (let i = 0; i < dropped.length; i += IMPORT_BATCH) {
      const batch = dropped.slice(i, i + IMPORT_BATCH);
      const result = await importMemories(batch);
      if (result.error) {
        // A whole-run failure (e.g. not signed in): stop and surface it.
        return { ...merged, ok: false, error: result.error };
      }
      merged.imported += result.imported;
      merged.unchanged += result.unchanged;
      merged.failed.push(...result.failed);
      report(Math.min(i + IMPORT_BATCH, dropped.length), dropped.length);
    }
    merged.ok = merged.failed.length === 0;
    return merged;
  }

  return (
    <MemoryTransferPanel
      labels={labels}
      onExport={handleExport}
      onImport={handleImport}
    />
  );
}
