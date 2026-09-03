import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type {
  ImportMemoryInput,
  ImportMemoryOutput,
} from '@workspace/contracts';
import { createLogger } from '@workspace/logger';
import { createAuthedTransport } from '@workspace/mcp-oauth-client';

import { resolveServerUrl } from './server-config.js';
import { toolErrorMessage } from './tool-result.js';

/**
 * Streamable HTTP MCP client for the `import_memory` tool — the same OAuth
 * transport the ingest client uses (run the watcher's `login` once to
 * authorize). Reconnects lazily after any failure. Calls are one-shot per item;
 * the server is idempotent per `source_hash`, so a re-run is safe.
 */
export class ImportClient {
  readonly #logger = createLogger(ImportClient.name);
  #client: Client | null = null;

  constructor(private readonly serverUrl: string = resolveServerUrl()) {}

  /** Imports one item; throws on transport/tool failure (caller decides). */
  async importMemory(input: ImportMemoryInput): Promise<ImportMemoryOutput> {
    const client = await this.#ensureConnected();
    try {
      const result = await client.callTool({
        name: 'import_memory',
        arguments: input,
      });
      const text = (result.content as Array<{ text?: string }>)
        .map((item) => item.text ?? '')
        .join('\n');
      if (result.isError) {
        throw new Error(
          `import_memory returned an error: ${toolErrorMessage(result)}`
        );
      }
      return JSON.parse(text) as ImportMemoryOutput;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /**
   * Kicks the server-side background hygiene scan (near-duplicate judging).
   * Called after an import lands new memories, so import↔existing pairs get
   * queued for review without a manual step. The server guards against
   * concurrent scans, so repeated triggers are safe.
   */
  async scanHygiene(): Promise<{ started: boolean; reason?: string }> {
    const client = await this.#ensureConnected();
    try {
      const result = await client.callTool({
        name: 'scan_hygiene',
        arguments: {},
      });
      const text = (result.content as Array<{ text?: string }>)
        .map((item) => item.text ?? '')
        .join('\n');
      if (result.isError) {
        throw new Error(`scan_hygiene returned an error: ${text}`);
      }
      return JSON.parse(text) as { started: boolean; reason?: string };
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
    this.#logger.info('connected to import server', { url: this.serverUrl });
    return client;
  }
}
