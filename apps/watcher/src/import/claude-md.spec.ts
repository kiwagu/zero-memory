import { describe, expect, it } from 'vitest';

import { splitClaudeMdSections } from './claude-md.js';

describe('splitClaudeMdSections', () => {
  it('splits level-2 sections and keeps the heading in the content', () => {
    const raw = [
      '# Title',
      'Intro prose about the project.',
      '',
      '## First rule',
      'Always do the first thing.',
      '',
      '## Second rule',
      'Never do the second thing.',
    ].join('\n');

    const sections = splitClaudeMdSections(raw);
    expect(sections.map((s) => s.heading)).toEqual([
      '',
      'First rule',
      'Second rule',
    ]);
    expect(sections[1]!.content).toContain('## First rule');
    expect(sections[1]!.content).toContain('Always do the first thing.');
    expect(sections[1]!.slug).toBe('first-rule');
  });

  it('drops heading-only and pure @-import sections', () => {
    const raw = [
      '# Project rules',
      'All rules live in .cursor/rules.',
      '',
      '## Always-on conventions',
      '@.cursor/rules/a.mdc',
      '@.cursor/rules/b.mdc',
      '',
      '## Empty section',
    ].join('\n');

    const sections = splitClaudeMdSections(raw);
    // Only the preamble (real prose) survives; @-import and heading-only go.
    expect(sections).toHaveLength(1);
    expect(sections[0]!.content).toContain('All rules live in .cursor/rules.');
  });

  it('returns nothing for a file that is only imports', () => {
    const raw = ['# Rules', '@.cursor/rules/a.mdc'].join('\n');
    expect(splitClaudeMdSections(raw)).toEqual([]);
  });
});
