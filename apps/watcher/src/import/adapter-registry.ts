import { ClaudeCodeSourceAdapter } from './claude-code-adapter.js';
import type { MemorySourceAdapter } from './source-adapter.js';

/**
 * The registered source adapters. Supporting a new tool (Cursor, VS Code,
 * Codex, ...) is adding its adapter here — the runner and the server stay
 * unchanged (strategy + registry).
 */
export const SOURCE_ADAPTERS: readonly MemorySourceAdapter[] = [
  new ClaudeCodeSourceAdapter(),
];
