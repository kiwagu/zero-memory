import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Markdown } from '@workspace/ui/components/common/markdown';

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

  it('links a bare memory id to its page', () => {
    const out = html('see mem_he4120z6tcgfk76a.01m32429w4 here');
    expect(out).toContain('href="/memory/mem_he4120z6tcgfk76a.01m32429w4"');
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
