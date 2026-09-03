import { describe, expect, it } from 'vitest';

import {
  collectMemoryIds,
  isRecallTool,
  toolBaseName,
} from './recall-tools.logic.js';

/**
 * Every form a real client has been OBSERVED to record this server's tools
 * under — the reason this helper is shared rather than per-adapter. Each was
 * read off an actual transcript on the dev host, never invented: a spec that
 * encoded an unobserved shape (`name: 'recall'` for Claude Code) is what kept
 * the judge channel silently dead for three weeks.
 */
const OBSERVED_TOOL_NAMES: ReadonlyArray<readonly [string, string]> = [
  // Claude Code — MCP registered at user scope.
  ['claude code, user-scope mount', 'mcp__zero-memory__recall'],
  // Claude Code — legacy plugin-bundled server.
  [
    'claude code, plugin-bundled mount',
    'mcp__plugin_zero-memory_zero-memory__recall',
  ],
  // Codex — `payload.name` is bare; the mount lives in `payload.namespace`.
  ['codex rollout function_call', 'recall'],
  // Cursor — `input.toolName` is bare; the mount is `input.namespace`.
  ['cursor CallDynamicTool', 'recall'],
];

describe('toolBaseName', () => {
  it.each(OBSERVED_TOOL_NAMES)('strips the mount prefix (%s)', (_, name) => {
    expect(toolBaseName(name)).toBe('recall');
  });

  it('leaves a name without a namespace untouched', () => {
    expect(toolBaseName('build_context')).toBe('build_context');
  });
});

describe('isRecallTool', () => {
  it.each(OBSERVED_TOOL_NAMES)('recognizes a recall call (%s)', (_, name) => {
    expect(isRecallTool(name)).toBe(true);
  });

  it('recognizes build_context under a namespace', () => {
    expect(isRecallTool('mcp__zero-memory__build_context')).toBe(true);
  });

  it.each([
    ['a write tool', 'mcp__zero-memory__remember'],
    ['an unrelated tool', 'Grep'],
    ['a bare write tool', 'remember'],
  ])('rejects %s', (_, name) => {
    expect(isRecallTool(name)).toBe(false);
  });

  it('rejects an absent name', () => {
    expect(isRecallTool(undefined)).toBe(false);
  });
});

describe('collectMemoryIds', () => {
  it('pulls ids out of a stringified result payload', () => {
    const payload = JSON.stringify({
      memories: [
        { id: 'mem_4yea92da91x38wav.01kychgcj4' },
        { id: 'mem_4299mdrbs4483hff.01kycfb3g7' },
      ],
    });
    expect(collectMemoryIds(payload)).toEqual([
      'mem_4yea92da91x38wav.01kychgcj4',
      'mem_4299mdrbs4483hff.01kycfb3g7',
    ]);
  });

  it('de-duplicates an id repeated across the payload', () => {
    const repeated = 'mem_4yea92da91x38wav.01kychgcj4';
    expect(collectMemoryIds(`${repeated} … ${repeated}`)).toEqual([repeated]);
  });

  it('ignores ids of other entity types and malformed ones', () => {
    expect(
      collectMemoryIds('ent_drgjbeqvqsedgn0f.01kx8g2wtm mem_short.01kychgcj4')
    ).toEqual([]);
  });

  it('returns nothing for a payload without ids', () => {
    expect(collectMemoryIds('Wall time: 4.9 seconds')).toEqual([]);
  });
});
