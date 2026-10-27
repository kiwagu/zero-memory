import * as React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  classifyHref,
  remarkCardLabelLinks,
  remarkHtmlAsText,
  remarkMemoryIdLinks,
} from '@workspace/ui/lib/markdown';
import { cn } from '@workspace/ui/lib/utils';

/**
 * Markdown — the one renderer for NARRATIVE text in the dashboard (a memory, a
 * card body, notes, reasons, drafts). Lists and previews keep their own
 * compact rendering; this is for text meant to be read.
 *
 * Text written by someone else is an injection channel, so: raw HTML shows as
 * literal text, images never load, script/data links render as plain text,
 * external links open in a new tab with their domain visible. Same-origin
 * links go through `linkComponent`, which is how the panel chain intercepts
 * them. A card label (`ZM-42`) links only to a card the caller resolved in
 * `cardLinks`, since a label names a card only on its own board. Display-only;
 * `imageLabel` arrives translated.
 */

type MarkdownDensity = 'card' | 'page' | 'inline';

interface MarkdownProps {
  children: string;
  density?: MarkdownDensity;
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
  /** Word shown in place of an image, e.g. "image". */
  imageLabel?: string;
  /** The cards a label in this text may link to: number → the card's page. */
  cardLinks?: Readonly<Record<string, string>>;
  className?: string;
  'data-testid'?: string;
}

const LINK_CLASS = 'underline underline-offset-2 hover:text-foreground';

const HEADING_CLASS: Record<'card' | 'page', [string, string, string]> = {
  // In a card a heading is a subdued label, not page typography.
  card: [
    'text-sm font-semibold text-foreground/90',
    'text-sm font-semibold text-foreground/90',
    'text-sm font-medium text-foreground/80',
  ],
  page: [
    'text-lg font-semibold',
    'text-base font-semibold',
    'text-sm font-semibold',
  ],
};

function components(
  density: MarkdownDensity,
  LinkComponent: React.ElementType,
  imageLabel: string
): Components {
  const headingClasses = HEADING_CLASS[density === 'page' ? 'page' : 'card'];
  const heading = (level: 0 | 1 | 2) => {
    const Heading = ({ children }: { children?: React.ReactNode }) => (
      <p className={cn('mt-3 first:mt-0', headingClasses[level])}>{children}</p>
    );
    return Heading;
  };

  return {
    a: ({ href, children }) => {
      const target = classifyHref(href);
      if (target.kind === 'internal') {
        return (
          <LinkComponent href={target.href} className={LINK_CLASS}>
            {children}
          </LinkComponent>
        );
      }
      if (target.kind === 'external') {
        const showDomain = target.domain !== '' && children !== target.href;
        return (
          <a
            href={target.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className={LINK_CLASS}
          >
            {children}
            {showDomain ? (
              <span className="text-muted-foreground ml-1 text-xs">
                ({target.domain})
              </span>
            ) : null}
          </a>
        );
      }
      return <span>{children}</span>;
    },
    img: ({ src, alt }) => {
      const target = classifyHref(typeof src === 'string' ? src : undefined);
      const label = `${imageLabel}: ${alt || '—'}`;
      return target.kind === 'external' ? (
        <a
          href={target.href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="text-muted-foreground text-xs"
        >
          [{label}
          {target.domain ? ` (${target.domain})` : ''}]
        </a>
      ) : (
        <span className="text-muted-foreground text-xs">[{label}]</span>
      );
    },
    p: ({ children }) =>
      density === 'inline' ? (
        <span className="whitespace-pre-line">{children}</span>
      ) : (
        <p className="whitespace-pre-line">{children}</p>
      ),
    h1: heading(0),
    h2: heading(1),
    h3: heading(2),
    h4: heading(2),
    h5: heading(2),
    h6: heading(2),
    ul: ({ children }) => (
      <ul className="list-disc space-y-1 pl-5">{children}</ul>
    ),
    // A list that starts at 3 in the text starts at 3 on screen.
    ol: ({ children, start }) => (
      <ol start={start} className="list-decimal space-y-1 pl-5">
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="whitespace-pre-line">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="text-muted-foreground border-l-2 pl-3">
        {children}
      </blockquote>
    ),
    pre: ({ children }) => (
      <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs [&_code]:bg-transparent [&_code]:p-0">
        {children}
      </pre>
    ),
    code: ({ children }) => (
      <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">
        {children}
      </code>
    ),
    table: ({ children }) => (
      <div className="overflow-x-auto">
        <table className="border-collapse text-xs">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border px-2 py-1 text-left font-medium">{children}</th>
    ),
    td: ({ children }) => (
      <td className="border px-2 py-1 align-top whitespace-pre-line">
        {children}
      </td>
    ),
    hr: () => <hr className="border-border my-3" />,
  };
}

function Markdown({
  children,
  density = 'card',
  linkComponent = 'a',
  imageLabel = 'image',
  cardLinks,
  className,
  'data-testid': testId,
}: MarkdownProps) {
  const rendered = (
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        remarkHtmlAsText,
        remarkMemoryIdLinks,
        ...(cardLinks ? [() => remarkCardLabelLinks(cardLinks)] : []),
      ]}
      components={components(density, linkComponent, imageLabel)}
    >
      {children}
    </ReactMarkdown>
  );

  if (density === 'inline') {
    return (
      <span className={cn('break-words', className)} data-testid={testId}>
        {rendered}
      </span>
    );
  }
  return (
    <div
      className={cn(
        'space-y-2 break-words',
        density === 'page'
          ? 'text-base leading-relaxed'
          : 'text-sm leading-relaxed',
        className
      )}
      data-testid={testId}
    >
      {rendered}
    </div>
  );
}

export { Markdown, type MarkdownProps };
