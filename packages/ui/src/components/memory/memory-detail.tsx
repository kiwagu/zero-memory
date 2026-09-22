import * as React from 'react';

import { DescriptionList } from '@workspace/ui/components/common/description-list';
import { DetailSection } from '@workspace/ui/components/common/detail-section';
import { Markdown } from '@workspace/ui/components/common/markdown';
import {
  EntityChipList,
  type EntityChipItem,
} from '@workspace/ui/components/entity/entity-chip-list';
import {
  LinkedMemoryList,
  type LinkedMemoryItem,
} from '@workspace/ui/components/memory/linked-memory-list';
import {
  MemoryBadges,
  type MemoryBadgeItem,
} from '@workspace/ui/components/memory/memory-card';
import {
  MemoryVersionList,
  type MemoryVersionItem,
} from '@workspace/ui/components/memory/memory-version-list';
import { OriginalDisclosure } from '@workspace/ui/components/memory/original-disclosure';

/**
 * MemoryDetail — one memory in full: its text, badges, validity, lifecycle,
 * versions, provenance, same-session siblings, entities and typed links.
 *
 * Rendered by the memory page and by a panel of the chain, so it must not know
 * which: everything arrives display-ready and serializable (labels translated,
 * hrefs built), and what differs — the back link, the owner's actions, the
 * sharing readout — comes in as slots. Links go through `linkComponent`, which
 * is how a panel keeps a click on the canvas.
 */

interface MemoryDetailSection<Item> {
  title: string;
  items: Item[];
  emptyLabel: string;
}

interface MemoryDetailData {
  id: string;
  content: string;
  original: { text: string; lang: string | null; toggle: string } | null;
  badges: MemoryBadgeItem[];
  validity: string;
  lifecycleTitle: string;
  lifecycle: Array<{ label: string; value: string; href?: string }>;
  versions: {
    title: string;
    items: MemoryVersionItem[];
    currentLabel: string;
    invalidatedLabel: string;
  } | null;
  provenance: {
    title: string;
    entries: Array<{ key: string; display: string; full?: string }> | null;
    emptyLabel: string;
  };
  sameSession: { title: string; items: LinkedMemoryItem[] } | null;
  entities: MemoryDetailSection<EntityChipItem>;
  linksOut: MemoryDetailSection<LinkedMemoryItem>;
  linksIn: MemoryDetailSection<LinkedMemoryItem>;
  hiddenLabel: string;
  imageLabel: string;
}

interface MemoryDetailProps extends MemoryDetailData {
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
  /** Above the memory — the page's way back. */
  header?: React.ReactNode;
  /** Beside the badges — who the memory is shared with. */
  badgesAside?: React.ReactNode;
  /** The owner's actions, in one row under the memory. */
  actions?: React.ReactNode;
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function MemoryDetail({
  id,
  content,
  original,
  badges,
  validity,
  lifecycleTitle,
  lifecycle,
  versions,
  provenance,
  sameSession,
  entities,
  linksOut,
  linksIn,
  hiddenLabel,
  imageLabel,
  linkComponent: LinkComponent = 'a',
  header,
  badgesAside,
  actions,
}: MemoryDetailProps) {
  return (
    <div className="space-y-4" data-testid="memory-detail">
      {header}

      <article
        data-testid="memory-detail-content"
        className="rounded-xl border bg-card p-5 text-card-foreground shadow-sm"
      >
        <div
          data-testid="memory-id"
          className="mb-3 font-mono text-xs break-all text-muted-foreground select-all"
        >
          {id}
        </div>
        <Markdown
          data-testid="memory-content"
          linkComponent={LinkComponent}
          imageLabel={imageLabel}
        >
          {content}
        </Markdown>
        {original ? (
          <OriginalDisclosure
            text={original.text}
            lang={original.lang}
            labels={{ toggle: original.toggle }}
          />
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <MemoryBadges badges={badges} />
          {badgesAside}
        </div>
        <p
          data-testid="memory-validity"
          className="mt-3 text-xs text-muted-foreground"
        >
          {validity}
        </p>
      </article>

      {/* One action row: share/forget, promote, move — every owner action on
          the memory sits together and wraps only when the viewport forces it,
          instead of stacking one control per line. */}
      {actions ? (
        <div className="flex flex-wrap items-start gap-2">{actions}</div>
      ) : null}

      <DetailSection title={lifecycleTitle}>
        <DescriptionList
          className="text-sm"
          items={lifecycle.map((item) => ({
            label: item.label,
            value: item.href ? (
              <LinkComponent href={item.href} className="hover:underline">
                {item.value}
              </LinkComponent>
            ) : (
              item.value
            ),
          }))}
        />
      </DetailSection>

      {versions ? (
        <DetailSection
          title={versions.title}
          data-testid="memory-version-history"
        >
          <MemoryVersionList
            linkComponent={LinkComponent}
            items={versions.items}
            currentLabel={versions.currentLabel}
            invalidatedLabel={versions.invalidatedLabel}
          />
        </DetailSection>
      ) : null}

      <DetailSection title={provenance.title} data-testid="memory-provenance">
        {provenance.entries ? (
          <dl className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs">
            {provenance.entries.map((entry) => (
              <div key={entry.key} className="flex gap-2 py-0.5">
                <dt className="text-muted-foreground shrink-0">{entry.key}</dt>
                <dd className="break-all" title={entry.full}>
                  {entry.display}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <Muted>{provenance.emptyLabel}</Muted>
        )}
      </DetailSection>

      {sameSession ? (
        <DetailSection
          title={sameSession.title}
          data-testid="memory-same-session"
        >
          {/* A TEMPORAL neighbourhood, not a semantic one: these facts were
              written in the same conversation, which is why the section says
              "same session" rather than "related" — typed links remain the
              only claim that two memories are about each other. */}
          <LinkedMemoryList
            linkComponent={LinkComponent}
            items={sameSession.items}
            hiddenLabel={hiddenLabel}
          />
        </DetailSection>
      ) : null}

      <DetailSection title={entities.title}>
        {entities.items.length > 0 ? (
          <EntityChipList
            linkComponent={LinkComponent}
            items={entities.items}
          />
        ) : (
          <Muted>{entities.emptyLabel}</Muted>
        )}
      </DetailSection>

      <DetailSection title={linksOut.title}>
        {linksOut.items.length > 0 ? (
          <LinkedMemoryList
            linkComponent={LinkComponent}
            items={linksOut.items}
            hiddenLabel={hiddenLabel}
          />
        ) : (
          <Muted>{linksOut.emptyLabel}</Muted>
        )}
      </DetailSection>

      <DetailSection title={linksIn.title}>
        {linksIn.items.length > 0 ? (
          <LinkedMemoryList
            linkComponent={LinkComponent}
            items={linksIn.items}
            hiddenLabel={hiddenLabel}
          />
        ) : (
          <Muted>{linksIn.emptyLabel}</Muted>
        )}
      </DetailSection>
    </div>
  );
}

export { MemoryDetail, type MemoryDetailData, type MemoryDetailProps };
