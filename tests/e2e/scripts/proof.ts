/**
 * When an e2e run may vouch for a tree, so the pre-push gate
 * (scripts/push-gate.sh) can let a push of that tree through without running
 * the smoke again. Each rule closes a way a pass could vouch for code it did
 * not test.
 */

export type Suite = 'full' | 'smoke';

/**
 * Which suite a launcher run is, or null when it cannot vouch for a tree.
 * Only the whole suite and the @smoke suite cover a tree as a whole, and only
 * a CI-mode run counts, the way the hook runs it: that mode forbids focused
 * tests (`test.only`), which would otherwise pass while running one test.
 */
export const suiteOf = (
  playwrightArgs: readonly string[],
  ci: boolean
): Suite | null => {
  if (!ci) {
    return null;
  }
  if (playwrightArgs.length === 0) {
    return 'full';
  }
  return ['--grep @smoke', '--grep=@smoke'].includes(playwrightArgs.join(' '))
    ? 'smoke'
    : null;
};

/**
 * Whether apps already up booted from another tree than the clean checkout
 * holds now. Their reuse is then refused even when no remaining source is
 * newer than their boot: a deleted file leaves nothing newer to notice.
 */
export const bootedFromAnotherTree = (
  appsTree: string | undefined,
  checkoutTree: string | null
): boolean => checkoutTree !== null && appsTree !== checkoutTree;

/**
 * The tree a run proved, or null. It proves the tree the checkout held when
 * it started, when the suite passed, the checkout was still clean on that
 * tree when it ended, and the apps it tested had booted from that tree.
 */
export const provenTree = (run: {
  passed: boolean;
  suite: Suite | null;
  treeAtStart: string | null;
  treeAtEnd: string | null;
  appsTree: string | undefined;
}): string | null =>
  run.passed &&
  run.suite !== null &&
  run.treeAtStart !== null &&
  run.treeAtEnd === run.treeAtStart &&
  run.appsTree === run.treeAtStart
    ? run.treeAtStart
    : null;
