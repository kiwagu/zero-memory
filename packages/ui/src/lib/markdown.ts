/**
 * The pieces of the dashboard's Markdown rendering that are pure logic: the
 * remark plugins and the link classifier. Typed structurally so the package
 * needs no mdast/unist type dependency.
 */

export type MdNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
};

const ID_CHARS = '[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]';

/** A zero-memory memory id, not followed by more id characters. */
export const MEMORY_ID_PATTERN = new RegExp(
  `\\bmem_${ID_CHARS}{16}\\.${ID_CHARS}{10}(?![0-9A-Za-z])`,
  'g'
);

/** Nodes whose text must never become a link. */
const NO_AUTOLINK = new Set([
  'link',
  'linkReference',
  'inlineCode',
  'code',
  'definition',
]);

function walk(node: MdNode, visit: (node: MdNode) => void): void {
  visit(node);
  node.children?.forEach((child) => walk(child, visit));
}

/**
 * Raw HTML never becomes markup. It is shown as the literal text it is —
 * dropping it (the renderer's default) would silently erase words like
 * `<Dialog>` from a memory.
 */
export function remarkHtmlAsText() {
  return (tree: MdNode): void => {
    walk(tree, (node) => {
      if (node.type === 'html') {
        node.type = 'text';
      }
    });
  };
}

export function splitMemoryIds(text: string): MdNode[] {
  const parts: MdNode[] = [];
  let last = 0;
  for (const match of text.matchAll(MEMORY_ID_PATTERN)) {
    const start = match.index;
    if (start > last) {
      parts.push({ type: 'text', value: text.slice(last, start) });
    }
    parts.push({
      type: 'link',
      url: `/memory/${match[0]}`,
      children: [{ type: 'text', value: match[0] }],
    });
    last = start + match[0].length;
  }
  if (parts.length === 0) {
    return [{ type: 'text', value: text }];
  }
  if (last < text.length) {
    parts.push({ type: 'text', value: text.slice(last) });
  }
  return parts;
}

/**
 * A card's label, `ZM-42`: not inside a word, and not running on into more
 * digits, letters or another dash-number.
 */
const CARD_LABEL_PATTERN = /(?<![0-9A-Za-z])ZM-(\d+)(?![0-9A-Za-z]|-\d)/g;

/**
 * The card numbers a set of texts mentions, each once, in order of first
 * mention — what a view resolves before it renders the texts.
 */
export function cardLabelNumbers(texts: readonly string[]): number[] {
  const numbers = new Set<number>();
  for (const text of texts) {
    for (const match of text.matchAll(CARD_LABEL_PATTERN)) {
      numbers.add(Number(match[1]));
    }
  }
  return [...numbers];
}

/**
 * Card labels in `text` become links to the cards `links` names, keyed by
 * number. A label of a card it was not given stays text: a card that does not
 * exist, or one the reader may not see, looks exactly like prose.
 */
export function splitCardLabels(
  text: string,
  links: Readonly<Record<string, string>>
): MdNode[] {
  const parts: MdNode[] = [];
  let last = 0;
  for (const match of text.matchAll(CARD_LABEL_PATTERN)) {
    const url = links[match[1] ?? ''];
    if (url === undefined) {
      continue;
    }
    const start = match.index;
    if (start > last) {
      parts.push({ type: 'text', value: text.slice(last, start) });
    }
    parts.push({
      type: 'link',
      url,
      children: [{ type: 'text', value: match[0] }],
    });
    last = start + match[0].length;
  }
  if (parts.length === 0) {
    return [{ type: 'text', value: text }];
  }
  if (last < text.length) {
    parts.push({ type: 'text', value: text.slice(last) });
  }
  return parts;
}

function linkifyChildren(
  node: MdNode,
  split: (text: string) => MdNode[]
): void {
  if (!node.children || NO_AUTOLINK.has(node.type)) {
    return;
  }
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text' && child.value) {
      return split(child.value);
    }
    linkifyChildren(child, split);
    return [child];
  });
}

/** A bare memory id in prose becomes a link to that memory. */
export function remarkMemoryIdLinks() {
  return (tree: MdNode): void => linkifyChildren(tree, splitMemoryIds);
}

/**
 * A card label in prose becomes a link to that card — only for the cards the
 * caller resolved, since a label means a card only on its own board.
 */
export function remarkCardLabelLinks(links: Readonly<Record<string, string>>) {
  return (tree: MdNode): void =>
    linkifyChildren(tree, (text) => splitCardLabels(text, links));
}

/** A placeholder origin no real link can have (the `.invalid` TLD is reserved). */
const INTERNAL_ORIGIN = 'https://app.invalid';

export type LinkTarget =
  | { kind: 'internal'; href: string }
  | { kind: 'external'; href: string; domain: string }
  | { kind: 'blocked' };

/**
 * Where a link in rendered text may go. Same-origin paths stay in the app;
 * http(s) and mailto open outside with their domain shown; everything else —
 * script, data and protocol-relative urls included — renders as plain text.
 */
export function classifyHref(href: string | null | undefined): LinkTarget {
  if (!href) {
    return { kind: 'blocked' };
  }
  if (href.startsWith('/')) {
    // Resolve against a placeholder origin: a path is internal only if it
    // stays there. Browsers read `//host`, `/\host` and similar as another
    // host, and the resolved form is what they would actually follow.
    try {
      const url = new URL(href, INTERNAL_ORIGIN);
      if (url.origin === INTERNAL_ORIGIN) {
        return {
          kind: 'internal',
          href: `${url.pathname}${url.search}${url.hash}`,
        };
      }
    } catch {
      // Unparseable: nothing safe to point at.
    }
    return { kind: 'blocked' };
  }
  try {
    const url = new URL(href);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return { kind: 'external', href: url.href, domain: url.hostname };
    }
    if (url.protocol === 'mailto:') {
      return { kind: 'external', href: url.href, domain: '' };
    }
  } catch {
    // Not an absolute url: nothing safe to point at.
  }
  return { kind: 'blocked' };
}
