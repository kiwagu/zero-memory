import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '@workspace/logger';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The watcher always mirrors its log lines to ZM_LOG_FILE, capped at
 * ZM_LOG_MAX_LINES, so a user can hand over recent diagnostics for the daemon
 * and the plugin's brief/ingest hooks. Exercises the logger's file sink through
 * the same public entrypoint the watcher uses.
 */
describe('rotating log file sink', () => {
  let dir: string;
  let logFile: string;
  const prevFile = process.env.ZM_LOG_FILE;
  const prevMax = process.env.ZM_LOG_MAX_LINES;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zm-log-'));
    logFile = join(dir, 'watcher.log');
    process.env.ZM_LOG_FILE = logFile;
    process.env.ZM_LOG_MAX_LINES = '5';
  });

  afterEach(() => {
    if (prevFile === undefined) {
      delete process.env.ZM_LOG_FILE;
    } else {
      process.env.ZM_LOG_FILE = prevFile;
    }
    if (prevMax === undefined) {
      delete process.env.ZM_LOG_MAX_LINES;
    } else {
      process.env.ZM_LOG_MAX_LINES = prevMax;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('rotates to the last N lines, keeping the newest and dropping the oldest', () => {
    const log = createLogger('test');
    for (let i = 0; i < 20; i += 1) {
      log.info(`line ${i}`);
    }
    const contents = readFileSync(logFile, 'utf8');
    const lines = contents.split('\n').filter(Boolean);
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toContain('"msg":"line 19"');
    expect(contents).not.toContain('"msg":"line 0"');
  });

  it('writes to the file regardless of console routing (LOG_STDERR=1)', () => {
    process.env.LOG_STDERR = '1';
    try {
      createLogger('test').info('routed to stderr');
    } finally {
      delete process.env.LOG_STDERR;
    }
    expect(readFileSync(logFile, 'utf8')).toContain('"msg":"routed to stderr"');
  });

  it('honors the level gate (debug suppressed by default, same as console)', () => {
    createLogger('test').debug('should not appear');
    createLogger('test').warn('should appear');
    const contents = readFileSync(logFile, 'utf8');
    expect(contents).not.toContain('should not appear');
    expect(contents).toContain('"msg":"should appear"');
  });
});
