/**
 * When the sync bar is on screen, given how many requests are pending.
 *
 * It appears only once work has been pending for `showAfterMs`, so a fast
 * request never flickers it. Once shown it stays at least `minVisibleMs`, so a
 * request that ends just after the delay does not blink it on and off. Work
 * that starts again while it is still shown keeps it on.
 */
export interface SyncVisibility {
  /** Feed the current pending-request count. */
  update(pending: number): void;
  /** Stops any scheduled change. */
  dispose(): void;
}

export const SYNC_SHOW_AFTER_MS = 200;
export const SYNC_MIN_VISIBLE_MS = 400;

export const createSyncVisibility = (
  onChange: (visible: boolean) => void,
  {
    showAfterMs = SYNC_SHOW_AFTER_MS,
    minVisibleMs = SYNC_MIN_VISIBLE_MS,
  }: { showAfterMs?: number; minVisibleMs?: number } = {}
): SyncVisibility => {
  let busy = false;
  let visible = false;
  let shownAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const show = () => {
    timer = null;
    visible = true;
    shownAt = Date.now();
    onChange(true);
  };
  const hide = () => {
    timer = null;
    visible = false;
    onChange(false);
  };

  return {
    update(pending) {
      const nowBusy = pending > 0;
      if (nowBusy === busy) {
        return;
      }
      busy = nowBusy;
      cancel();
      if (busy) {
        if (!visible) {
          timer = setTimeout(show, showAfterMs);
        }
        return;
      }
      if (visible) {
        const left = minVisibleMs - (Date.now() - shownAt);
        if (left > 0) {
          timer = setTimeout(hide, left);
        } else {
          hide();
        }
      }
    },
    dispose: cancel,
  };
};
