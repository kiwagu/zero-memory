/**
 * The pieces of the dashboard's Markdown rendering that are pure logic: two
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

function linkifyChildren(node: MdNode): void {
  if (!node.children || NO_AUTOLINK.has(node.type)) {
    return;
  }
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text' && child.value) {
      return splitMemoryIds(child.value);
    }
    linkifyChildren(child);
    return [child];
  });
}

/** A bare memory id in prose becomes a link to that memory. */
export function remarkMemoryIdLinks() {
  return (tree: MdNode): void => linkifyChildren(tree);
}

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
  if (href.startsWith('/') && !href.startsWith('//')) {
    return { kind: 'internal', href };
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
