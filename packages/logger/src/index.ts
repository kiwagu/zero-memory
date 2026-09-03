import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(bindings: LogContext): Logger;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const resolveMinLevel = (): LogLevel => {
  const raw = (process.env.LOG_LEVEL ?? '').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
};

/** Default rotation cap for the file sink (lines kept). */
const DEFAULT_LOG_MAX_LINES = 200;

const resolveMaxLines = (): number => {
  const raw = Number(process.env.ZM_LOG_MAX_LINES);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_LOG_MAX_LINES;
};

let logDirEnsured = false;

/**
 * Best-effort mirror of a log line to the file at ZM_LOG_FILE, trimmed to the
 * last ZM_LOG_MAX_LINES (default 200) so it never grows unbounded — a
 * persistent, rotating copy of exactly the lines the console shows, for
 * after-the-fact diagnostics (e.g. the plugin's short-lived brief/ingest hooks,
 * whose stderr otherwise only surfaces under `claude --debug`). Opt-in via the
 * env var so only apps that want it (the watcher) pay for it; never throws — a
 * logging failure must not break the caller.
 */
const appendToLogFile = (line: string): void => {
  const path = process.env.ZM_LOG_FILE;
  if (!path) {
    return;
  }
  try {
    if (!logDirEnsured) {
      mkdirSync(dirname(path), { recursive: true });
      logDirEnsured = true;
    }
    appendFileSync(path, `${line}\n`);
    const cap = resolveMaxLines();
    // A trailing '' follows the final newline, so real line count is length - 1.
    const lines = readFileSync(path, 'utf8').split('\n');
    if (lines.length - 1 > cap) {
      writeFileSync(path, lines.slice(lines.length - 1 - cap).join('\n'));
    }
  } catch {
    // ignore — logging must never break the app
  }
};

/** Source of ambient log fields, e.g. a correlation id from an ALS store. */
export type LogContextResolver = () => LogContext | undefined;

let contextResolver: LogContextResolver | undefined;

/**
 * Register a source of ambient fields merged into every log entry (typically a
 * request/run correlation id from an AsyncLocalStorage the app layer owns).
 * Keeps this package a dependency-free leaf: the store lives upstream, the
 * logger only reads it through this hook. Explicit call-site bindings win over
 * resolved fields. Pass undefined to clear (tests).
 */
export const setLogContextResolver = (
  resolver: LogContextResolver | undefined
): void => {
  contextResolver = resolver;
};

const write = (
  level: LogLevel,
  name: string,
  bindings: LogContext,
  message: string,
  context?: LogContext
): void => {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[resolveMinLevel()]) {
    return;
  }
  // Ambient fields (e.g. the request/run correlation id) come first so an
  // explicit call-site binding or context still wins on key collision.
  const ambient = contextResolver?.();
  const entry = {
    level,
    time: new Date().toISOString(),
    name,
    msg: message,
    ...ambient,
    ...bindings,
    ...context,
  };
  const line = JSON.stringify(entry);
  // Persistent rotating copy first (same lines, same level gate as the
  // console) so it captures output regardless of stdout/stderr routing.
  appendToLogFile(line);
  // LOG_STDERR=1 sends every level to stderr — required by stdio transports
  // (e.g. MCP) where stdout must carry protocol frames only.
  if (level === 'error' || process.env.LOG_STDERR === '1') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
};

const buildLogger = (name: string, bindings: LogContext): Logger => ({
  debug: (message, context) => write('debug', name, bindings, message, context),
  info: (message, context) => write('info', name, bindings, message, context),
  warn: (message, context) => write('warn', name, bindings, message, context),
  error: (message, context) => write('error', name, bindings, message, context),
  child: (childBindings) =>
    buildLogger(name, { ...bindings, ...childBindings }),
});

export const createLogger = (name: string, bindings: LogContext = {}): Logger =>
  buildLogger(name, bindings);
