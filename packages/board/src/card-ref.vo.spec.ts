import { newCardId, newMemoryId } from '@workspace/contracts';
import { describe, expect, it } from 'vitest';

import {
  cardRefKey,
  flattenCardRef,
  parseCardRef,
  sameCardRef,
} from './card-ref.vo.js';

describe('cardRefKey', () => {
  it('identifies a reference by its kind and target', () => {
    const id = newMemoryId();

    expect(cardRefKey({ kind: 'memory', id })).toBe(`memory:${id}`);
    expect(cardRefKey({ kind: 'url', url: 'https://example.invalid/a' })).toBe(
      'url:https://example.invalid/a'
    );
  });

  it('treats two references to one target as the same reference', () => {
    const id = newMemoryId();

    expect(sameCardRef({ kind: 'memory', id }, { kind: 'memory', id })).toBe(
      true
    );
    expect(
      sameCardRef({ kind: 'memory', id }, { kind: 'card', id: newCardId() })
    ).toBe(false);
  });
});

describe('parseCardRef', () => {
  it('accepts the closed vocabulary', () => {
    expect(parseCardRef({ kind: 'memory', id: newMemoryId() }).isOk()).toBe(
      true
    );
    expect(
      parseCardRef({ kind: 'url', url: 'https://example.invalid' }).isOk()
    ).toBe(true);
  });

  it('refuses a loop kind: an open loop attaches as the memory it is', () => {
    expect(parseCardRef({ kind: 'loop', id: newMemoryId() }).isErr()).toBe(
      true
    );
  });

  it('refuses a malformed target and a target of the wrong kind', () => {
    expect(parseCardRef({ kind: 'memory', id: 'not-an-id' }).isErr()).toBe(
      true
    );
    expect(parseCardRef({ kind: 'memory', id: newCardId() }).isErr()).toBe(
      true
    );
    expect(parseCardRef({ kind: 'url', url: 'not a url' }).isErr()).toBe(true);
  });
});

describe('flattenCardRef', () => {
  it('stores a kind and one opaque target, whatever the kind', () => {
    const id = newMemoryId();

    expect(flattenCardRef({ kind: 'memory', id })).toEqual({
      kind: 'memory',
      target: id,
    });
    expect(
      flattenCardRef({ kind: 'url', url: 'https://example.invalid/a' })
    ).toEqual({ kind: 'url', target: 'https://example.invalid/a' });
  });
});

describe('a branch reference', () => {
  it('keys and flattens a branch as <repo>:<branch>', () => {
    const ref = { kind: 'branch' as const, repo: 'o/n', name: 'feature/x' };
    expect(cardRefKey(ref)).toBe('branch:o/n:feature/x');
    expect(flattenCardRef(ref)).toEqual({
      kind: 'branch',
      target: 'o/n:feature/x',
    });
    expect(parseCardRef(ref).isOk()).toBe(true);
  });
});
