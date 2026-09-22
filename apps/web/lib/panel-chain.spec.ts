import { describe, expect, it } from 'vitest';

import {
  branchOf,
  chainReducer,
  initialChain,
  panelKey,
  parsePanelHref,
  type ChainState,
} from './panel-chain';

const CARD = 'crd_0000000000000000.0000000000';
const A = 'mem_aaaaaaaaaaaaaaaa.aaaaaaaaaa';
const B = 'mem_bbbbbbbbbbbbbbbb.bbbbbbbbbb';
const C = 'mem_cccccccccccccccc.cccccccccc';
const root = panelKey('card', CARD);
const keys = (state: ChainState) => state.panels.map((panel) => panel.key);
const open = (state: ChainState, id: string, from: string) =>
  chainReducer(state, { type: 'open', kind: 'memory', id, from });

describe('chainReducer', () => {
  it('inserts a panel right after its source and keeps the rest', () => {
    let state = initialChain({ kind: 'card', id: CARD });
    state = open(state, A, root);
    state = open(state, B, panelKey('memory', A));
    state = open(state, C, root);
    expect(keys(state)).toEqual([
      root,
      panelKey('memory', C),
      panelKey('memory', A),
      panelKey('memory', B),
    ]);
  });

  it('does not duplicate an open resource, it focuses it', () => {
    let state = open(initialChain({ kind: 'card', id: CARD }), A, root);
    const before = state.focus?.seq ?? 0;
    state = open(state, A, root);
    expect(keys(state)).toHaveLength(2);
    expect(state.focus).toEqual({
      key: panelKey('memory', A),
      seq: before + 1,
    });
  });

  it('closes a panel together with everything opened from it', () => {
    let state = initialChain({ kind: 'card', id: CARD });
    state = open(state, A, root);
    state = open(state, B, panelKey('memory', A));
    state = open(state, C, root);
    state = chainReducer(state, { type: 'close', key: panelKey('memory', A) });
    expect(keys(state)).toEqual([root, panelKey('memory', C)]);
    expect(state.openOrder).toEqual([panelKey('memory', C)]);
  });

  it('closes the most recently opened panel first', () => {
    let state = initialChain({ kind: 'card', id: CARD });
    state = open(state, A, root);
    state = open(state, C, root);
    state = chainReducer(state, { type: 'closeLast' });
    expect(keys(state)).toEqual([root, panelKey('memory', A)]);
  });

  it('never closes the root, and ignores an open from a vanished source', () => {
    const state = initialChain({ kind: 'card', id: CARD });
    expect(chainReducer(state, { type: 'close', key: root })).toBe(state);
    expect(chainReducer(state, { type: 'closeLast' })).toBe(state);
    expect(open(state, A, 'memory:gone')).toBe(state);
  });
});

describe('branchOf', () => {
  it('collects descendants transitively', () => {
    const panels = [
      { key: 'r', kind: 'card' as const, id: 'r', from: null },
      { key: 'a', kind: 'memory' as const, id: 'a', from: 'r' },
      { key: 'b', kind: 'memory' as const, id: 'b', from: 'a' },
      { key: 'c', kind: 'memory' as const, id: 'c', from: 'b' },
    ];
    expect([...branchOf(panels, 'a')].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('parsePanelHref', () => {
  it('recognises memory, card and entity pages', () => {
    expect(parsePanelHref(`/memory/${A}`)).toEqual({
      type: 'panel',
      kind: 'memory',
      id: A,
    });
    expect(parsePanelHref(`/memory/${A}?from=kind%3Dfact`)).toEqual({
      type: 'panel',
      kind: 'memory',
      id: A,
    });
    expect(parsePanelHref(`/board/${CARD}`)).toEqual({
      type: 'panel',
      kind: 'card',
      id: CARD,
    });
    expect(parsePanelHref('/entities/ent_0000000000000000.0000000000')).toEqual(
      {
        type: 'panel',
        kind: 'entity',
        id: 'ent_0000000000000000.0000000000',
      }
    );
  });

  it('sends absolute http links outside and leaves the rest alone', () => {
    expect(parsePanelHref('https://example.com/x')).toEqual({
      type: 'external',
    });
    expect(parsePanelHref('/memories?kind=fact')).toEqual({ type: 'none' });
    expect(parsePanelHref('/memory/not-an-id')).toEqual({ type: 'none' });
  });
});
