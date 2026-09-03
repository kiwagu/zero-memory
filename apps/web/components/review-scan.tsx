'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@workspace/ui/components/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components/select';

import { scanForDuplicates } from '@/lib/review-actions';

const QUICK_LIMIT = 10;

export interface ReviewScanLabels {
  scan: string;
  scanning: string;
  started: string;
  modeQuick: string;
  modeFull: string;
}

export function ReviewScanButton({ labels }: { labels: ReviewScanLabels }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [mode, setMode] = useState<'quick' | 'full'>('quick');

  function handleScan() {
    setError(null);
    setStarted(false);
    startTransition(async () => {
      const result = await scanForDuplicates(
        mode === 'quick' ? QUICK_LIMIT : undefined
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // The scan runs in the background; show the current queue and hint that
      // more conflicts may appear shortly.
      setStarted(true);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Select
        value={mode}
        onValueChange={(value) => setMode(value as 'quick' | 'full')}
      >
        <SelectTrigger
          size="sm"
          className="w-36"
          data-testid="review-scan-mode"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="quick">{labels.modeQuick}</SelectItem>
          <SelectItem value="full">{labels.modeFull}</SelectItem>
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        data-testid="review-scan"
        onClick={handleScan}
      >
        {pending ? labels.scanning : labels.scan}
      </Button>
      {started ? (
        <span className="text-muted-foreground text-sm">{labels.started}</span>
      ) : null}
      {error ? <span className="text-destructive text-sm">{error}</span> : null}
    </div>
  );
}
