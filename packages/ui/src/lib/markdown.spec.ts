import { describe, expect, it } from 'vitest';

import {
  cardLabelNumbers,
  classifyHref,
  remarkCardLabelLinks,
  remarkHtmlAsText,
  remarkMemoryIdLinks,
  splitCardLabels,
  splitMemoryIds,
  type MdNode,
} from '@workspace/ui/lib/markdown';

const ID = 'mem_he4120z6tcgfk76a.01m32429w4';
const CARD_LINKS = { '7': '/board/crd_seven' };

describe('splitCardLabels', () => {
  it('turns a label of a known card into a link to that card', () => {
    expect(splitCardLabels('blocked by ZM-7.', CARD_LINKS)).toEqual([
      { type: 'text', value: 'blocked by ' },
      {
        type: 'link',
        url: '/board/crd_seven',
        children: [{ type: 'text', value: 'ZM-7' }],
      },
      { type: 'text', value: '.' },
    ]);
  });

  it('leaves the label of a card it was not given as text', () => {
    expect(splitCardLabels('see ZM-8', CARD_LINKS)).toEqual([
      { type: 'text', value: 'see ZM-8' },
    ]);
  });

  it('does not link a label that runs on or starts inside a word', () => {
    expect(splitCardLabels('ZM-70 xZM-7 ZM-7a ZM-7-2', CARD_LINKS)).toEqual([
      { type: 'text', value: 'ZM-70 xZM-7 ZM-7a ZM-7-2' },
    ]);
  });
});

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
});

describe('card labels agree between collection and rendering', () => {
  it('treats a label no card can have as text in both', () => {
    const links = { '7': '/board/crd_seven', '2147483647': '/board/crd_max' };
    for (const text of ['ZM-007', 'ZM-0', 'ZM-2147483648']) {
      expect(cardLabelNumbers([text])).toEqual([]);
      expect(splitCardLabels(text, links)).toEqual([
        { type: 'text', value: text },
      ]);
    }
    expect(splitCardLabels('ZM-2147483647', links)).toEqual([
      {
        type: 'link',
        url: '/board/crd_max',
        children: [{ type: 'text', value: 'ZM-2147483647' }],
      },
    ]);
  });
});

describe('splitMemoryIds', () => {
  it('turns a bare memory id into a link to its page', () => {
    expect(splitMemoryIds(`see ${ID} for why`)).toEqual([
      { type: 'text', value: 'see ' },
      {
        type: 'link',
        url: `/memory/${ID}`,
        children: [{ type: 'text', value: ID }],
      },
      { type: 'text', value: ' for why' },
    ]);
  });

  it('leaves text without an id as one text node', () => {
    expect(splitMemoryIds('nothing here')).toEqual([
      { type: 'text', value: 'nothing here' },
    ]);
  });

  it('does not link an id that runs on into more id characters', () => {
    expect(splitMemoryIds(`${ID}x`)).toEqual([
      { type: 'text', value: `${ID}x` },
    ]);
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

describe('remarkHtmlAsText', () => {
  it('turns raw html into literal text instead of dropping it', () => {
    const tree: MdNode = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'html', value: '<Dialog>' }],
        },
      ],
    };
    remarkHtmlAsText()(tree);
    expect(tree.children?.[0]?.children?.[0]).toEqual({
      type: 'text',
      value: '<Dialog>',
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
