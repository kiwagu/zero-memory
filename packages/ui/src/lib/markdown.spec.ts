import { describe, expect, it } from 'vitest';

import {
  classifyHref,
  remarkHtmlAsText,
  remarkMemoryIdLinks,
  splitMemoryIds,
  type MdNode,
} from '@workspace/ui/lib/markdown';

const ID = 'mem_he4120z6tcgfk76a.01m32429w4';

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
