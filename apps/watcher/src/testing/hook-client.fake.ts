import type { HookClient, HookInput } from '../hook-client.js';

/** A hook's stdin payload, with every field a test does not name left empty. */
export const hookInput = (input: Partial<HookInput> = {}): HookInput => ({
  sessionId: '',
  cwd: process.cwd(),
  prompt: '',
  transcriptPath: '',
  hookEventName: '',
  toolName: '',
  alreadyContinued: false,
  source: '',
  trigger: '',
  ...input,
});

/** A client whose every output channel lands in `emitted`, in order. */
export interface FakeHookClient extends HookClient {
  readonly emitted: string[];
}

/**
 * A hook client that reads `input` and records what the runner emits.
 *
 * Codex by default: it takes the Claude hook I/O without the Claude-plugin-only
 * update check at session start, so a briefing test sees only the briefing.
 * Any field can be overridden, the client kind and its capabilities included.
 */
export const fakeHookClient = (
  input: Partial<HookInput> = {},
  overrides: Partial<HookClient> = {}
): FakeHookClient => {
  const emitted: string[] = [];
  const record = (text: string): void => void emitted.push(text);
  return {
    kind: 'codex',
    ingestProvenance: 'test',
    canTaskBrief: true,
    canAnchorCompaction: false,
    readInput: async () => hookInput(input),
    parse: () => {
      throw new Error('this hook never parses a transcript');
    },
    emitSessionBrief: record,
    emitTaskBrief: record,
    emitTurnContext: (_event, text) => record(text),
    emitReceipt: record,
    emitCompactionAnchor: record,
    ...overrides,
    emitted,
  };
};
