/**
 * The panel chain opened from a card dialog: which resources can be panels,
 * and what their ids look like.
 */

export type PanelKind = 'memory' | 'card' | 'entity';

const ID_CHARS = '[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]';
const PREFIX: Record<PanelKind, string> = {
  memory: 'mem',
  card: 'crd',
  entity: 'ent',
};

export function isPanelKind(value: string): value is PanelKind {
  return value === 'memory' || value === 'card' || value === 'entity';
}

export function isPanelId(kind: PanelKind, id: string): boolean {
  return new RegExp(`^${PREFIX[kind]}_${ID_CHARS}{16}\\.${ID_CHARS}{10}$`).test(
    id
  );
}

export interface PanelRef {
  key: string;
  kind: PanelKind;
  id: string;
  /** The panel this one was opened from; null only for the root card. */
  from: string | null;
}

export interface ChainState {
  /** Left to right as shown; the root card is always first. */
  panels: PanelRef[];
  /** Keys in the order they were opened — what Escape unwinds. */
  openOrder: string[];
  /** The panel to bring into view; `seq` re-triggers it for the same key. */
  focus: { key: string; seq: number } | null;
}

export type ChainAction =
  | { type: 'open'; kind: PanelKind; id: string; from: string }
  | { type: 'close'; key: string }
  | { type: 'closeLast' };

export const panelKey = (kind: PanelKind, id: string): string =>
  `${kind}:${id}`;

export function initialChain(root: {
  kind: PanelKind;
  id: string;
}): ChainState {
  return {
    panels: [
      {
        key: panelKey(root.kind, root.id),
        kind: root.kind,
        id: root.id,
        from: null,
      },
    ],
    openOrder: [],
    focus: null,
  };
}

/** A panel and every panel opened from it, however deep. */
export function branchOf(panels: PanelRef[], key: string): Set<string> {
  const branch = new Set([key]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const panel of panels) {
      if (
        panel.from !== null &&
        branch.has(panel.from) &&
        !branch.has(panel.key)
      ) {
        branch.add(panel.key);
        grew = true;
      }
    }
  }
  return branch;
}

/**
 * The chain's rules. A new panel goes right after the panel it was opened
 * from, and the rest of the canvas stays; a resource already open is brought
 * into view instead of opened twice; closing a panel closes everything opened
 * from it; Escape closes the most recently opened panel. The root card is the
 * dialog's to close, never the chain's.
 */
export function chainReducer(
  state: ChainState,
  action: ChainAction
): ChainState {
  switch (action.type) {
    case 'open': {
      const key = panelKey(action.kind, action.id);
      const seq = (state.focus?.seq ?? 0) + 1;
      if (state.panels.some((panel) => panel.key === key)) {
        return { ...state, focus: { key, seq } };
      }
      const at = state.panels.findIndex((panel) => panel.key === action.from);
      if (at === -1) {
        return state;
      }
      const panel: PanelRef = {
        key,
        kind: action.kind,
        id: action.id,
        from: action.from,
      };
      return {
        panels: [
          ...state.panels.slice(0, at + 1),
          panel,
          ...state.panels.slice(at + 1),
        ],
        openOrder: [...state.openOrder, key],
        focus: { key, seq },
      };
    }
    case 'close': {
      if (action.key === state.panels[0]?.key) {
        return state;
      }
      const branch = branchOf(state.panels, action.key);
      return {
        panels: state.panels.filter((panel) => !branch.has(panel.key)),
        openOrder: state.openOrder.filter((key) => !branch.has(key)),
        focus: state.focus && branch.has(state.focus.key) ? null : state.focus,
      };
    }
    case 'closeLast': {
      const last = state.openOrder.at(-1);
      return last ? chainReducer(state, { type: 'close', key: last }) : state;
    }
  }
}

export type PanelTarget =
  | { type: 'panel'; kind: PanelKind; id: string }
  | { type: 'external' }
  | { type: 'none' };

const PAGE_OF: Array<[RegExp, PanelKind]> = [
  [/^\/memory\/([^/?#]+)/, 'memory'],
  [/^\/board\/([^/?#]+)/, 'card'],
  [/^\/entities\/([^/?#]+)/, 'entity'],
];

/** What a link inside a panel should do: open a panel, leave the app, or navigate. */
export function parsePanelHref(href: string): PanelTarget {
  if (/^https?:\/\//i.test(href)) {
    return { type: 'external' };
  }
  for (const [pattern, kind] of PAGE_OF) {
    const id = pattern.exec(href)?.[1];
    if (id && isPanelId(kind, id)) {
      return { type: 'panel', kind, id };
    }
  }
  return { type: 'none' };
}
