import {
  boardOutputSchema,
  type CardBranchView,
  type CardState,
} from '@workspace/contracts';

import { withBoundedClient } from './bounded-client.js';
import { resolveServerUrl } from './server-config.js';
import {
  parseToolPayload,
  toolErrorCode,
  toolErrorMessage,
} from './tool-result.js';

export interface CardBranches {
  card: { id: string; number: number; state: CardState } | null;
  branches: CardBranchView[];
}

/**
 * A card by its project-local number, with the branches it records — the
 * question the landing check asks. One authenticated connection, two reads:
 * `board resolve` turns the number into the card, `board get` reads its
 * branches. A number with no card answers `card: null`; any other failure
 * throws, so the caller can tell "no such card" from "could not ask". The
 * whole exchange ends at the deadline.
 */
export const callCardBranches = (
  scope: string,
  number: number,
  timeoutMs: number,
  serverUrl: string = resolveServerUrl()
): Promise<CardBranches> =>
  withBoundedClient(
    'zero-memory-landing',
    serverUrl,
    timeoutMs,
    async (client, options) => {
      const resolved = await client.callTool(
        {
          name: 'board',
          arguments: { action: 'resolve', scope, number },
        },
        undefined,
        options
      );
      if (resolved.isError) {
        if (toolErrorCode(resolved) === 'not_found') {
          return { card: null, branches: [] };
        }
        throw new Error(`board resolve failed: ${toolErrorMessage(resolved)}`);
      }
      const card = boardOutputSchema.parse(parseToolPayload(resolved)).card;
      if (!card) {
        return { card: null, branches: [] };
      }
      const read = await client.callTool(
        {
          name: 'board',
          arguments: { action: 'get', card_id: card.id, limit: 1 },
        },
        undefined,
        options
      );
      if (read.isError) {
        throw new Error(`board get failed: ${toolErrorMessage(read)}`);
      }
      const view = boardOutputSchema.parse(parseToolPayload(read));
      return {
        card: { id: card.id, number: card.number, state: card.state },
        branches: view.branches,
      };
    }
  );
