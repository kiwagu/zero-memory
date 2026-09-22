'use client';

import {
  ArrowRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  XIcon,
} from 'lucide-react';
import * as React from 'react';

import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import { cn } from '@workspace/ui/lib/utils';

/**
 * PanelStrip — the chain of panels opened from a dialog: equal-width twins of
 * the dialog in one row, snapping panel to panel, paged by large arrows centred
 * on the screen edges (the row's own scrollbar is hidden on purpose). Each
 * panel says where it was opened from and closes with its ×.
 *
 * Controlled and display-only: which panels exist, their content and what a
 * close does all arrive from the app. `focus` brings a panel into view; its
 * `seq` lets the same panel be brought back again. A click on the empty
 * space between and around the panels is `onEmptyClick` — the backdrop of
 * whatever holds the strip.
 */

interface PanelStripItem {
  key: string;
  kindLabel: string;
  title: string;
  fromLabel?: string;
  onFromClick?: () => void;
  onClose: () => void;
  closeLabel: string;
  content: React.ReactNode;
}

interface PanelStripProps {
  items: PanelStripItem[];
  labels: { previous: string; next: string };
  focus: { key: string; seq: number } | null;
  onEmptyClick?: () => void;
}

function PanelStrip({ items, labels, focus, onEmptyClick }: PanelStripProps) {
  const rowRef = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({ previous: false, next: false });

  const measure = React.useCallback(() => {
    const row = rowRef.current;
    if (!row) {
      return;
    }
    setEdges({
      previous: row.scrollLeft > 1,
      next: row.scrollLeft + row.clientWidth < row.scrollWidth - 1,
    });
  }, []);

  React.useEffect(() => {
    const row = rowRef.current;
    if (!row) {
      return;
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    row.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      row.removeEventListener('scroll', measure);
    };
  }, [measure, items.length]);

  React.useEffect(() => {
    if (!focus) {
      return;
    }
    const panel = rowRef.current?.querySelector<HTMLElement>(
      `[data-panel-key="${CSS.escape(focus.key)}"]`
    );
    if (!panel) {
      return;
    }
    panel.scrollIntoView({
      behavior: 'smooth',
      inline: 'nearest',
      block: 'nearest',
    });
    panel.focus({ preventScroll: true });
    // A brief ring says "this one" — the answer to opening something already
    // open.
    panel.dataset.flash = 'true';
    const timer = window.setTimeout(() => {
      delete panel.dataset.flash;
    }, 900);
    return () => window.clearTimeout(timer);
  }, [focus]);

  const page = (direction: 1 | -1) => {
    const row = rowRef.current;
    const panel = row?.querySelector<HTMLElement>('[data-panel-key]');
    if (!row || !panel) {
      return;
    }
    const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
    row.scrollBy({
      left: direction * (panel.offsetWidth + gap),
      behavior: 'smooth',
    });
  };

  return (
    <div className="relative h-full w-full" data-testid="panel-strip">
      <div
        ref={rowRef}
        className="scrollbar-none flex h-full w-full snap-x snap-mandatory scroll-px-16 items-center justify-center-safe gap-4 overflow-x-auto overflow-y-hidden px-16"
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            onEmptyClick?.();
          }
        }}
      >
        {items.map((item, index) => (
          <React.Fragment key={item.key}>
            {index > 0 ? (
              <ArrowRightIcon
                aria-hidden
                className="text-muted-foreground size-5 shrink-0"
              />
            ) : null}
            <section
              data-panel-key={item.key}
              data-testid="panel"
              tabIndex={-1}
              aria-label={item.title}
              className="bg-popover text-popover-foreground ring-foreground/10 data-[flash=true]:ring-primary flex max-h-[85vh] w-[48rem] max-w-[calc(100vw-8rem)] shrink-0 snap-start flex-col rounded-xl shadow-lg ring-1 transition-shadow outline-none data-[flash=true]:ring-2"
            >
              <header className="flex items-center gap-2 border-b px-4 py-2">
                <Badge variant="secondary">{item.kindLabel}</Badge>
                <span
                  className="min-w-0 flex-1 truncate text-sm font-medium"
                  data-testid="panel-title"
                >
                  {item.title}
                </span>
                {item.fromLabel ? (
                  <button
                    type="button"
                    onClick={item.onFromClick}
                    className="text-muted-foreground hover:text-foreground max-w-[40%] shrink-0 truncate text-xs"
                    data-testid="panel-from"
                  >
                    {item.fromLabel}
                  </button>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={item.onClose}
                  aria-label={item.closeLabel}
                  data-testid="panel-close"
                >
                  <XIcon />
                </Button>
              </header>
              <div className="scrollbar-stable overflow-y-auto p-6">
                {item.content}
              </div>
            </section>
          </React.Fragment>
        ))}
      </div>
      <Button
        variant="outline"
        size="icon"
        aria-label={labels.previous}
        onClick={() => page(-1)}
        className={cn(
          'fixed top-1/2 left-3 z-[60] size-12 -translate-y-1/2 rounded-full shadow-md',
          !edges.previous && 'hidden'
        )}
        data-testid="panel-previous"
      >
        <ChevronLeftIcon className="size-6" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        aria-label={labels.next}
        onClick={() => page(1)}
        className={cn(
          'fixed top-1/2 right-3 z-[60] size-12 -translate-y-1/2 rounded-full shadow-md',
          !edges.next && 'hidden'
        )}
        data-testid="panel-next"
      >
        <ChevronRightIcon className="size-6" />
      </Button>
    </div>
  );
}

export { PanelStrip, type PanelStripItem, type PanelStripProps };
