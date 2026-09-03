/**
 * Print the MCP server `instructions` a given client would receive on
 * connect — the text that lands in that client's system prompt.
 *
 * The server tailors this per client: one that documents a hard cap on the
 * channel (Claude Code truncates at 2KB, silently) receives the router plus
 * an announcement naming the call that delivers the rules, while any other
 * client receives the promoted rules inline, in full. This script makes that
 * difference inspectable instead of theoretical: it performs a real
 * initialize against the server, under the watcher's OAuth session, and
 * prints what came back.
 *
 * Usage (from the repo root):
 *   bun scripts/show-instructions.ts                     # as claude-code
 *   bun scripts/show-instructions.ts cursor              # as another client
 *   bun scripts/show-instructions.ts claude-code --raw   # no summary header
 *   ZM_SERVER_URL=http://localhost:8787/mcp bun scripts/show-instructions.ts
 *
 * Requires an authorized machine (`zero-memory-watcher login`).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createAuthedTransport } from '@workspace/mcp-oauth-client';
import { resolveServerUrl } from '@workspace/client-runtime';
import { RULE_DELIVERY } from '@workspace/db';

const args = process.argv.slice(2);
const raw = args.includes('--raw');
const clientName = args.find((arg) => !arg.startsWith('--')) ?? 'claude-code';

const main = async (): Promise<void> => {
  const serverUrl = resolveServerUrl();
  // The name below is what the server reads from clientInfo to decide how
  // much rule text this client can carry — that is the whole point here.
  const client = new Client({ name: clientName, version: '0.0.0' });
  await client.connect(createAuthedTransport(serverUrl));
  try {
    const instructions = client.getInstructions() ?? '';
    if (raw) {
      process.stdout.write(`${instructions}\n`);
      return;
    }
    const budget = RULE_DELIVERY.instructionVisibleBudget;
    const visible = instructions.slice(0, budget);
    const cut = instructions.length > budget;
    process.stdout.write(
      [
        `server:       ${serverUrl}`,
        `client name:  ${clientName}`,
        `instructions: ${instructions.length} chars`,
        `a ${budget}-char client would see: ${cut ? `the first ${budget} (the rest is cut)` : 'all of it'}`,
        '',
        '--- what the model receives ---',
        cut ? visible : instructions,
        ...(cut
          ? [
              '',
              `--- cut here (${instructions.length - budget} chars beyond) ---`,
            ]
          : []),
        '',
      ].join('\n')
    );
  } finally {
    await client.close();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(
    `failed to read instructions: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
