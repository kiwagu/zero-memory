import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The runtime log path — the same ZM_LOG_FILE the logger writes to. */
const logFilePath = (): string =>
  process.env.ZM_LOG_FILE ||
  join(homedir(), '.local', 'state', 'zero-memory', 'watcher.log');

/**
 * `logs [-f]` — print the watcher runtime log to stdout for live diagnostics on
 * any machine (plugin-only or daemon), without `claude --debug` or a running
 * daemon. With `-f`, follow appended lines (polling; handles the file's 200-line
 * rotation by reprinting from the start when it shrinks). Ctrl-C to stop.
 */
export const runLogs = async (follow: boolean): Promise<void> => {
  const path = logFilePath();
  let offset = 0;

  const flush = (): void => {
    let buf: Buffer;
    try {
      buf = readFileSync(path);
    } catch {
      return; // not created yet — nothing to show
    }
    if (buf.length < offset) {
      offset = 0; // rotated/truncated: re-emit from the top
    }
    if (buf.length > offset) {
      process.stdout.write(buf.subarray(offset));
      offset = buf.length;
    }
  };

  flush();
  if (offset === 0) {
    process.stderr.write(`(no runtime log yet at ${path})\n`);
  }
  if (!follow) {
    return;
  }
  // Follow mode: poll for appends until interrupted.
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    flush();
  }
};
