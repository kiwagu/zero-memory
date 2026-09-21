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

/**
 * The name that tells one scope from another: its last meaningful label.
 *
 * A full path is unreadable in a chip and useless when truncated — `proj.….zero_`
 * names nothing. What distinguishes two scopes is their slug (`zero_memory`,
 * `acme`), so that is what a picker or a heading shows, with the full path
 * kept in a `title` for whoever needs it.
 *
 * Per-owner id segments are skipped, since they are identical across one
 * user's scopes; a path made only of them falls through to its own display
 * form rather than rendering empty.
 */
export function scopeSlug(scope: unknown): string {
  const labels = String(scope)
    .split('.')
    .filter((label) => label !== '' && !label.startsWith('usr_'));
  return labels.at(-1) ?? scopeDisplay(scope);
}

/**
 * How a scope is written in a DROPDOWN, on every screen that offers one.
 *
 * One rule, so the same project reads the same way in the memory feed, the
 * rules groups and the board picker: the alias its owner gave it, and failing
 * that the slug that distinguishes it. The full path belongs in a `title`,
 * never in the visible label — truncated, a path says nothing.
 */
export function scopeOptionLabel(
  scope: unknown,
  alias?: string | null
): string {
  return alias && alias.trim() !== '' ? alias : scopeSlug(scope);
}
