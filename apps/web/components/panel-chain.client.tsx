'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { CardDetail } from '@workspace/ui/components/board/card-detail';
import { Button } from '@workspace/ui/components/button';
import { EmptyState } from '@workspace/ui/components/common/empty-state';
import { EntityDetail } from '@workspace/ui/components/entity/entity-detail';
import { PanelStrip } from '@workspace/ui/components/panels/panel-strip';

import { MemoryDetailView } from '@/components/memory-detail-view';
import {
  parsePanelHref,
  type ChainAction,
  type ChainState,
  type PanelKind,
  type PanelRef,
} from '@/lib/panel-chain';
import type { CardViewData } from '@/lib/views/card.view';
import type { EntityViewData } from '@/lib/views/entity.view';
import type { MemoryViewData } from '@/lib/views/memory.view';

export type PanelChainLabels = {
  previous: string;
  next: string;
  close: string;
  /** Contains `{title}`. */
  from: string;
  loading: string;
  unavailable: string;
  retry: string;
  kind: Record<PanelKind, string>;
};

type PanelPayload =
  | { kind: 'memory'; title: string; view: MemoryViewData }
  | { kind: 'card'; title: string; view: CardViewData }
  | { kind: 'entity'; title: string; view: EntityViewData };

const ChainContext = React.createContext<React.Dispatch<ChainAction> | null>(
  null
);
/** The key of the panel a link sits in — the source of what it opens. */
const SourceContext = React.createContext<string | null>(null);

/**
 * A link that, inside the chain, opens the resource as a panel next to the one
 * it sits in. A modified click (new tab, new window) and any link outside a
 * chain behave as a normal link; an external url always opens a new tab.
 */
export function PanelLink({
  href,
  children,
  ...rest
}: {
  href: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const dispatch = React.useContext(ChainContext);
  const source = React.useContext(SourceContext);
  const target = parsePanelHref(href);
  if (target.type === 'external') {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        {...rest}
      >
        {children}
      </a>
    );
  }
  if (!dispatch || !source || target.type === 'none') {
    return (
      <Link href={href} {...rest}>
        {children}
      </Link>
    );
  }
  return (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        if (
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0
        ) {
          return;
        }
        event.preventDefault();
        dispatch({
          type: 'open',
          kind: target.kind,
          id: target.id,
          from: source,
        });
      }}
    >
      {children}
    </a>
  );
}

type PanelLoad =
  | { status: 'loading' }
  | { status: 'ready'; payload: PanelPayload }
  | { status: 'missing' }
  | { status: 'error' };

function PanelContent({
  panel,
  labels,
  onTitle,
}: {
  panel: PanelRef;
  labels: PanelChainLabels;
  onTitle: (key: string, title: string) => void;
}) {
  const router = useRouter();
  const [load, setLoad] = React.useState<PanelLoad>({ status: 'loading' });
  // Bumping it reads the panel again (after an action, or on retry).
  const [version, setVersion] = React.useState(0);

  React.useEffect(() => {
    // A response that arrives after the panel moved on must not overwrite it.
    let cancelled = false;
    const settle = (next: PanelLoad) => {
      if (!cancelled) {
        setLoad(next);
      }
    };
    void (async () => {
      try {
        const response = await fetch(`/api/panels/${panel.kind}/${panel.id}`, {
          cache: 'no-store',
        });
        if (response.status === 404) {
          settle({ status: 'missing' });
          return;
        }
        if (
          !response.ok ||
          !response.headers.get('content-type')?.includes('application/json')
        ) {
          settle({ status: 'error' });
          return;
        }
        const payload = (await response.json()) as PanelPayload;
        settle({ status: 'ready', payload });
        if (!cancelled) {
          onTitle(panel.key, payload.title);
        }
      } catch {
        settle({ status: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [panel.kind, panel.id, panel.key, onTitle, version]);

  const reload = React.useCallback(() => {
    setVersion((current) => current + 1);
  }, []);

  // After an action the panel reads itself again, and the page under the
  // dialog — the card, the board — refreshes too.
  const onDone = React.useCallback(() => {
    reload();
    router.refresh();
  }, [reload, router]);

  if (load.status === 'loading') {
    return <EmptyState compact>{labels.loading}</EmptyState>;
  }
  if (load.status === 'missing') {
    return (
      <EmptyState compact data-testid="panel-unavailable">
        {labels.unavailable}
      </EmptyState>
    );
  }
  if (load.status === 'error') {
    return (
      <div className="flex flex-col items-start gap-2">
        <EmptyState compact>{labels.unavailable}</EmptyState>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setLoad({ status: 'loading' });
            reload();
          }}
        >
          {labels.retry}
        </Button>
      </div>
    );
  }
  const { payload } = load;
  if (payload.kind === 'memory') {
    return (
      <MemoryDetailView
        view={payload.view}
        onDone={onDone}
        linkComponent={PanelLink}
      />
    );
  }
  if (payload.kind === 'card') {
    return <CardDetail {...payload.view.detail} linkComponent={PanelLink} />;
  }
  return <EntityDetail {...payload.view.detail} linkComponent={PanelLink} />;
}

/**
 * The card and the panels its links opened, as one strip. The chain's state
 * lives with the dialog (it decides what Escape does); this renders it: the
 * root card as already rendered on the server, every other panel loading its
 * own view from the panel API.
 */
export function PanelChain({
  state,
  dispatch,
  root,
  rootTitle,
  labels,
  onCloseRoot,
}: {
  state: ChainState;
  dispatch: React.Dispatch<ChainAction>;
  root: React.ReactNode;
  rootTitle: string;
  labels: PanelChainLabels;
  onCloseRoot: () => void;
}) {
  const rootKey = state.panels[0]?.key ?? '';
  const [titles, setTitles] = React.useState<Record<string, string>>({
    [rootKey]: rootTitle,
  });
  const onTitle = React.useCallback((key: string, title: string) => {
    setTitles((current) =>
      current[key] === title ? current : { ...current, [key]: title }
    );
  }, []);

  const sourceOf = (panel: PanelRef) =>
    panel.from === null
      ? undefined
      : state.panels.find((candidate) => candidate.key === panel.from);

  return (
    <ChainContext.Provider value={dispatch}>
      <PanelStrip
        labels={{ previous: labels.previous, next: labels.next }}
        focus={state.focus}
        items={state.panels.map((panel) => {
          const source = sourceOf(panel);
          return {
            key: panel.key,
            kindLabel: labels.kind[panel.kind],
            title: titles[panel.key] ?? labels.loading,
            fromLabel: source
              ? labels.from.replace('{title}', titles[source.key] ?? '…')
              : undefined,
            // The source is open already, so "open" only brings it into view.
            onFromClick: source
              ? () =>
                  dispatch({
                    type: 'open',
                    kind: source.kind,
                    id: source.id,
                    from: source.key,
                  })
              : undefined,
            onClose: source
              ? () => dispatch({ type: 'close', key: panel.key })
              : onCloseRoot,
            closeLabel: labels.close,
            content: (
              <SourceContext.Provider value={panel.key}>
                {source ? (
                  <PanelContent
                    panel={panel}
                    labels={labels}
                    onTitle={onTitle}
                  />
                ) : (
                  root
                )}
              </SourceContext.Provider>
            ),
          };
        })}
      />
    </ChainContext.Provider>
  );
}
