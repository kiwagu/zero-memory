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
