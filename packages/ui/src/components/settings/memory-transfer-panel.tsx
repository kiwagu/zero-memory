'use client';

import * as React from 'react';
import { Download, Upload } from 'lucide-react';

import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { Button } from '@workspace/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@workspace/ui/components/card';
import { Dropzone } from '@workspace/ui/components/common/dropzone';
import { ProgressBar } from '@workspace/ui/components/common/progress-bar';

export interface MemoryTransferLabels {
  exportTitle: string;
  exportDescription: string;
  exportAction: string;
  exportPreparing: string;
  /** Template with {pct}. */
  exportProgress: string;
  exportHint: string;
  importTitle: string;
  importDescription: string;
  importDropHint: string;
  importBrowse: string;
  /** Template with {done} {total}. */
  importProgress: string;
  importReset: string;
  /** Template with {imported} {unchanged} {failed}. */
  summaryTemplate: string;
}

/** Result of an import run, rendered as a summary. Counts + generic failures. */
export interface MemoryTransferSummary {
  ok: boolean;
  imported: number;
  unchanged: number;
  failed: { path: string; error: string }[];
  /** A whole-run failure message (e.g. not signed in). */
  error?: string;
}

function fill(
  template: string,
  values: Record<string, string | number>
): string {
  return Object.entries(values).reduce(
    (out, [key, value]) => out.replace(`{${key}}`, String(value)),
    template
  );
}

/**
 * Presentational export/import panel (memory-as-code). Owns only presentation
 * and progress/summary STATE; all infrastructure is injected:
 *   - `onExport(report)` runs the export, calling `report(pct)` (null = busy,
 *     total unknown) and resolving when the download is triggered; a rejection
 *     surfaces as an error.
 *   - `onImport(files, report)` runs the import, calling `report(done, total)`
 *     and resolving to a summary (or null for "nothing to do").
 * No network, actions, i18n, or domain types leak in — copy comes via `labels`.
 */
export function MemoryTransferPanel({
  labels,
  onExport,
  onImport,
}: {
  labels: MemoryTransferLabels;
  onExport: (report: (pct: number | null) => void) => Promise<void>;
  onImport: (
    files: File[],
    report: (done: number, total: number) => void
  ) => Promise<MemoryTransferSummary | null>;
}) {
  const [exporting, setExporting] = React.useState(false);
  const [exportPct, setExportPct] = React.useState<number | null>(null);
  const [exportError, setExportError] = React.useState<string | null>(null);

  const [importProgress, setImportProgress] = React.useState<{
    done: number;
    total: number;
  } | null>(null);
  const [summary, setSummary] = React.useState<MemoryTransferSummary | null>(
    null
  );
  const importing = importProgress !== null;

  async function handleExport() {
    setExporting(true);
    setExportPct(null);
    setExportError(null);
    try {
      await onExport(setExportPct);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
    }
  }

  async function handleFiles(files: File[]) {
    if (importing) {
      return;
    }
    setSummary(null);
    setImportProgress({ done: 0, total: 0 });
    const result = await onImport(files, (done, total) =>
      setImportProgress({ done, total })
    );
    setImportProgress(null);
    setSummary(result);
  }

  const importPct =
    importProgress && importProgress.total > 0
      ? Math.round((importProgress.done / importProgress.total) * 100)
      : null;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card data-testid="settings-export">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="size-4" /> {labels.exportTitle}
          </CardTitle>
          <CardDescription>{labels.exportDescription}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            variant="outline"
            size="sm"
            disabled={exporting}
            onClick={handleExport}
            data-testid="settings-export-button"
          >
            {labels.exportAction}
          </Button>
          {exporting ? (
            <ProgressBar
              pct={exportPct}
              label={
                exportPct === null
                  ? labels.exportPreparing
                  : fill(labels.exportProgress, { pct: exportPct })
              }
            />
          ) : null}
          {exportError ? (
            <Alert variant="destructive">
              <AlertDescription>{exportError}</AlertDescription>
            </Alert>
          ) : null}
          <p className="text-muted-foreground text-xs italic">
            {labels.exportHint}
          </p>
        </CardContent>
      </Card>

      <Card data-testid="settings-import">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="size-4" /> {labels.importTitle}
          </CardTitle>
          <CardDescription>{labels.importDescription}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Dropzone
            testId="settings-import-dropzone"
            onFiles={handleFiles}
            accept=".md,.markdown,.zip"
            disabled={importing}
            icon={<Upload className="text-muted-foreground size-5" />}
            labels={{
              hint: labels.importDropHint,
              browse: labels.importBrowse,
            }}
          />

          {importProgress ? (
            <ProgressBar
              pct={importPct}
              label={fill(labels.importProgress, {
                done: importProgress.done,
                total: importProgress.total,
              })}
            />
          ) : null}

          {summary ? (
            <div className="space-y-2" data-testid="settings-import-summary">
              <Alert variant={summary.ok ? 'default' : 'destructive'}>
                <AlertDescription>
                  {summary.error ??
                    fill(labels.summaryTemplate, {
                      imported: summary.imported,
                      unchanged: summary.unchanged,
                      failed: summary.failed.length,
                    })}
                </AlertDescription>
              </Alert>
              {summary.failed.length > 0 ? (
                <ul className="text-destructive space-y-1 text-xs">
                  {summary.failed.map((failure) => (
                    <li key={failure.path}>
                      <span className="font-mono">{failure.path}</span>:{' '}
                      {failure.error}
                    </li>
                  ))}
                </ul>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSummary(null)}
              >
                {labels.importReset}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
