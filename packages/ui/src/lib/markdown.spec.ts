import { describe, expect, it } from 'vitest';

import {
  cardLabelNumbers,
  classifyHref,
  remarkCardLabelLinks,
  remarkMemoryIdLinks,
  type MdNode,
} from '@workspace/ui/lib/markdown';

const ID = 'mem_he4120z6tcgfk76a.01m32429w4';
const CARD_LINKS = { '7': '/board/crd_seven' };

describe('remarkCardLabelLinks', () => {
  it('links labels in text but never inside code or an existing link', () => {
    const tree: MdNode = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'text', value: 'a ZM-7' }] },
        {
          type: 'paragraph',
          children: [{ type: 'inlineCode', value: 'ZM-7' }],
        },
        {
          type: 'link',
          url: '/x',
          children: [{ type: 'text', value: 'ZM-7' }],
        },
      ],
    };
    remarkCardLabelLinks(CARD_LINKS)(tree);
    expect(tree.children?.[0]?.children?.[1]).toMatchObject({
      type: 'link',
      url: '/board/crd_seven',
    });
    expect(tree.children?.[1]?.children?.[0]).toEqual({
      type: 'inlineCode',
      value: 'ZM-7',
    });
    expect(tree.children?.[2]?.children?.[0]).toEqual({
      type: 'text',
      value: 'ZM-7',
    });
  });
});

describe('cardLabelNumbers', () => {
  it('collects each card number the texts mention, once', () => {
    expect(
      cardLabelNumbers(['after ZM-7 and ZM-12', 'ZM-7 again, not ZM-3a'])
    ).toEqual([7, 12]);
  });

  it('finds nothing in text without a label', () => {
    expect(cardLabelNumbers(['plain', ''])).toEqual([]);
  });

  it('never collects a number no card can have', () => {
    // A card number is a positive 32-bit integer written without leading
    // zeros; anything else must not reach the query, where an out-of-range
    // integer would fail the whole card view.
    expect(
      cardLabelNumbers([
        'ZM-2147483647 ZM-2147483648 ZM-99999999999999999999',
        'ZM-0 ZM-007',
      ])
    ).toEqual([2147483647]);
  });

  it('collects only the labels the renderer would link: none from code or links', () => {
    const text = [
      'Prose names ZM-1 and *emphasis* names ZM-2.',
      '',
      '- a list item names ZM-3',
      '',
      'Inline `ZM-4` code, a [ZM-5 link](https://example.com/ZM-6),',
      'an autolink <https://example.com/ZM-7> and a bare https://example.com/ZM-8 url.',
      '',
      '```',
      'ZM-9 in a fenced block',
      '```',
      '',
      '    ZM-10 in an indented block',
      '',
      'Raw <b>ZM-11</b> html is shown as text, so it links.',
    ].join('\n');
    expect(cardLabelNumbers([text])).toEqual([1, 2, 3, 11]);
  });

  it('lets a real mention through however many labels a code block holds', () => {
    const example = Array.from({ length: 150 }, (_, i) => `ZM-${i + 1}`).join(
      ' '
    );
    const numbers = cardLabelNumbers([
      `\`\`\`\n${example}\n\`\`\``,
      'Blocked by ZM-9000.',
    ]);
    expect(numbers).toEqual([9000]);
  });
});

describe('remarkMemoryIdLinks', () => {
  it('links ids in text but never inside code or an existing link', () => {
    const tree: MdNode = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'text', value: `a ${ID}` }] },
        { type: 'paragraph', children: [{ type: 'inlineCode', value: ID }] },
        { type: 'link', url: '/x', children: [{ type: 'text', value: ID }] },
      ],
    };
    remarkMemoryIdLinks()(tree);
    expect(tree.children?.[0]?.children?.[1]).toMatchObject({
      type: 'link',
      url: `/memory/${ID}`,
    });
    expect(tree.children?.[1]?.children?.[0]).toEqual({
      type: 'inlineCode',
      value: ID,
    });
    expect(tree.children?.[2]?.children?.[0]).toEqual({
      type: 'text',
      value: ID,
    });
  });
});

describe('classifyHref', () => {
  it('keeps same-origin paths internal', () => {
    expect(classifyHref('/memory/x')).toEqual({
      kind: 'internal',
      href: '/memory/x',
    });
  });

  it('treats a protocol-relative url as not internal', () => {
    expect(classifyHref('//evil.example/x')).toEqual({ kind: 'blocked' });
  });

  it('does not let a backslash smuggle another host into a path', () => {
    // Browsers read `/\host` as `//host`, so it would leave the app unmarked.
    expect(classifyHref('/\\evil.example/x')).toEqual({ kind: 'blocked' });
    expect(classifyHref('/\t/evil.example')).toEqual({ kind: 'blocked' });
  });

  it('names the domain of an external link', () => {
    expect(classifyHref('https://docs.example.com/a?b=1')).toEqual({
      kind: 'external',
      href: 'https://docs.example.com/a?b=1',
      domain: 'docs.example.com',
    });
  });

  it('blocks script and data schemes and empty hrefs', () => {
    expect(classifyHref('javascript:alert(1)')).toEqual({ kind: 'blocked' });
    expect(classifyHref('data:text/html,x')).toEqual({ kind: 'blocked' });
    expect(classifyHref('')).toEqual({ kind: 'blocked' });
    expect(classifyHref(undefined)).toEqual({ kind: 'blocked' });
  });
});
