import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Markdown } from '@workspace/ui/components/common/markdown';
import { cardLabelNumbers } from '@workspace/ui/lib/markdown';

const html = (text: string, density?: 'card' | 'page' | 'inline') =>
  renderToStaticMarkup(<Markdown density={density}>{text}</Markdown>);

describe('Markdown', () => {
  it('renders lists, emphasis and code', () => {
    const out = html('**bold**\n\n- one\n- two\n\n`x`');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<li');
    expect(out).toContain('<code');
  });

  it('shows raw html as literal text, never as markup', () => {
    const out = html(
      'before <script>alert(1)</script> <b>x</b> the <Dialog> part'
    );
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<b>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&lt;Dialog&gt;');
  });

  it('never loads an image', () => {
    const out = html('![diagram](https://img.example.com/a.png)');
    expect(out).not.toContain('<img');
    expect(out).toContain('diagram');
    expect(out).toContain('img.example.com');
  });

  it('drops script links to plain text', () => {
    const out = html('[click](javascript:alert(1))');
    expect(out).not.toContain('javascript:');
    expect(out).not.toMatch(/<a[^>]*>click<\/a>/);
    expect(out).toContain('click');
  });

  it('opens external links safely and names their domain', () => {
    const out = html('[docs](https://docs.example.com/x)');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('docs.example.com');
  });

  it('links a bare memory id to its page, but not one that runs on', () => {
    const id = 'mem_he4120z6tcgfk76a.01m32429w4';
    expect(html(`see ${id} here`)).toContain(`href="/memory/${id}"`);
    expect(html(`see ${id}x here`)).not.toContain('href="/memory/');
  });

  it('links the label of a card it was given, and only that', () => {
    const out = renderToStaticMarkup(
      <Markdown cardLinks={{ '7': '/board/crd_seven' }}>
        {'blocked by ZM-7, see `ZM-7` and ZM-8'}
      </Markdown>
    );
    expect(out).toMatch(/<a[^>]*href="\/board\/crd_seven"[^>]*>ZM-7<\/a>/);
    expect(out.match(/href="\/board\/crd_seven"/g)).toHaveLength(1);
    expect(out).toMatch(/<code[^>]*>ZM-7<\/code>/);
    expect(out).not.toMatch(/<a[^>]*>ZM-8<\/a>/);
  });

  it('leaves card labels as text when given no cards', () => {
    expect(html('blocked by ZM-7')).not.toContain('<a');
  });

  it('does not link a label that runs on or starts inside a word', () => {
    const out = renderToStaticMarkup(
      <Markdown cardLinks={{ '7': '/board/crd_seven' }}>
        {'ZM-70 xZM-7 ZM-7a ZM-7-2'}
      </Markdown>
    );
    expect(out).not.toContain('<a');
  });

  it('agrees with the collected labels on a number no card can have', () => {
    // What a view resolves and what the render links must be the same set:
    // a label that is never collected must never link either.
    const cardLinks = {
      '7': '/board/crd_seven',
      '2147483647': '/board/crd_max',
    };
    const rendered = (text: string) =>
      renderToStaticMarkup(<Markdown cardLinks={cardLinks}>{text}</Markdown>);
    for (const text of ['ZM-007', 'ZM-0', 'ZM-2147483648']) {
      expect(cardLabelNumbers([text])).toEqual([]);
      expect(rendered(text)).not.toContain('<a');
    }
    expect(cardLabelNumbers(['ZM-2147483647'])).toEqual([2147483647]);
    expect(rendered('ZM-2147483647')).toMatch(
      /<a[^>]*href="\/board\/crd_max"[^>]*>ZM-2147483647<\/a>/
    );
  });

  it('keeps a single line break as a break', () => {
    const out = html('line one\nline two');
    expect(out).toContain('whitespace-pre-line');
    expect(out).toContain('line one\nline two');
  });

  it('keeps the number an ordered list starts at', () => {
    expect(html('3. third\n4. fourth')).toContain('start="3"');
  });

  it('renders inline density without block paragraphs', () => {
    expect(html('just a reason', 'inline')).not.toContain('<p');
  });
});
