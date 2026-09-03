import { describe, expect, it } from 'vitest';

import { EMBEDDING_WINDOW_CHARS } from '@workspace/embedding';

import { oversizeDirective } from './oversize-directive.js';

describe('oversizeDirective', () => {
  const directive = oversizeDirective(4200, 2);

  it('reports what this write already cost, in its own numbers', () => {
    // A report of something that happened, which is the half a writer cannot
    // skim past as easily as a request.
    expect(directive).toContain('4200 characters');
    expect(directive).toContain('3 windows');
  });

  it('instructs the NEXT write rather than asking politely', () => {
    expect(directive).toContain('Keep the next one');
    expect(directive).toContain('ONE durable fact');
    expect(directive).toContain(String(EMBEDDING_WINDOW_CHARS));
  });

  it('gives the reasons that survive, not the one that was removed', () => {
    // Retrieval no longer punishes length, and saying otherwise would be a
    // lie the writer can check.
    expect(directive).toContain('no longer punished by search');
    expect(directive).toContain('2400');
    expect(directive).toContain('superseded in halves');
  });

  it('counts windows as covering windows, not as overflow alone', () => {
    // One overflow window means two windows covered the record; an off-by-one
    // here would tell the writer their record is smaller than it is.
    expect(oversizeDirective(2000, 1)).toContain('2 windows');
  });
});
