import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  ingestConversationOutputSchema,
  type IngestConversationInput,
  type IngestConversationOutput,
} from '@workspace/contracts';
import { createLogger } from '@workspace/logger';
import { createAuthedTransport } from '@workspace/mcp-oauth-client';

import { resolveServerUrl } from './server-config.js';
import { toolErrorMessage } from './tool-result.js';

/**
 * Streamable HTTP MCP client for the ingest_conversation tool. Authentication
 * is OAuth: the file-backed provider attaches the stored access token and
 * refreshes it on expiry (run the watcher's `login` subcommand once to
 * authorize). Connections are rebuilt lazily after any failure so the watcher
 * survives server restarts (callers add the retry/backoff).
 */
export class IngestClient {
  readonly #logger = createLogger(IngestClient.name);
  #client: Client | null = null;

  constructor(private readonly serverUrl: string = resolveServerUrl()) {}

  /**
   * Sends one chunk; throws on transport/tool failure (caller retries).
   * Returns the parsed ingest response — the Stop hook feeds its
   * `memories_created` into the session receipt.
   */
  async sendChunk(
    input: IngestConversationInput
  ): Promise<IngestConversationOutput> {
    const client = await this.#ensureConnected();
    try {
      const result = await client.callTool({
        name: 'ingest_conversation',
        arguments: input,
      });
      const text = (result.content as Array<{ text?: string }>)
        .map((item) => item.text ?? '')
        .join('\n');
      if (result.isError) {
        throw new Error(
          `ingest_conversation returned an error: ${toolErrorMessage(result)}`
        );
      }
      this.#logger.info('chunk sent', {
        conversationId: input.conversation_id,
        chunkHash: input.chunk_hash.slice(0, 12),
      });
      return ingestConversationOutputSchema.parse(JSON.parse(text));
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    if (client) {
      await client.close().catch(() => undefined);
    }
  }

  async #ensureConnected(): Promise<Client> {
    if (this.#client) {
      return this.#client;
    }
    const client = new Client({
      name: 'zero-memory-watcher',
      version: '0.1.0',
    });
    await client.connect(createAuthedTransport(this.serverUrl));
    this.#client = client;
    this.#logger.info('connected to ingest server', { url: this.serverUrl });
    return client;
  }
}
