/**
 * Scope display + classification helpers shared across the dashboard.
 *
 * Per-owner scopes carry an `usr_…` id segment (`proj.usr_ab12_01k.acme`)
 * that is identical for all of one user's scopes and pure noise in a UI
 * label. These helpers keep display and grouping consistent wherever a scope
 * is shown.
 */

/** True for the personal / user-layer scopes (`user`, `user.…`, `user.….core`). */
export function isPersonalScope(scope: string): boolean {
  return scope === 'user' || scope.startsWith('user.');
}

/**
 * Display-only scope label: collapses per-owner id segments (`usr_…`) to an
 * ellipsis so the informative labels — the root and the slug — survive in
 * tight chips and dropdowns (`proj.….acme`). Never a value; pair it with the
 * full path in a `title`.
 */
export function scopeDisplay(scope: unknown): string {
  return String(scope)
    .split('.')
    .map((label) => (label.startsWith('usr_') ? '…' : label))
    .join('.');
}
