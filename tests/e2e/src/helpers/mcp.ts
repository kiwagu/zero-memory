/**
 * Thin MCP-over-HTTP client for the protocol specs: Streamable HTTP transport
 * against /mcp with a Supabase JWT as the Bearer token — the exact surface an
 * external MCP client (Claude Code, the watcher) talks to.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { e2eEnv } from './env.js';

export interface McpToolResult {
  isError?: boolean;
  content: Array<{
    type: string;
    text?: string;
    uri?: string;
    annotations?: { priority?: number };
  }>;
}

export class McpTestClient {
  readonly #client: Client;
  readonly #transport: StreamableHTTPClientTransport;

  private constructor(
    client: Client,
    transport: StreamableHTTPClientTransport
  ) {
    this.#client = client;
    this.#transport = transport;
  }

  static async connect(
    accessToken: string,
    clientName = 'zm-e2e'
  ): Promise<McpTestClient> {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${e2eEnv.serverUrl}/mcp`),
      {
        requestInit: {
          headers: { authorization: `Bearer ${accessToken}` },
        },
      }
    );
    const client = new Client({ name: clientName, version: '0.1.0' });
    await client.connect(transport);
    return new McpTestClient(client, transport);
  }

  async listToolNames(): Promise<string[]> {
    const { tools } = await this.#client.listTools();
    return tools.map((tool) => tool.name);
  }

  /** Server `instructions` captured from the initialize handshake. */
  instructions(): string {
    return this.#client.getInstructions() ?? '';
  }

  /**
   * Contract version announced on the initialize handshake, or undefined when
   * the server declares no contract capability.
   */
  contractVersion(): string | undefined {
    const experimental = this.#client.getServerCapabilities()?.experimental;
    const declared = experimental?.['zero-memory/contract'] as
      { version?: string } | undefined;
    return declared?.version;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    return (await this.#client.callTool({
      name,
      arguments: args,
    })) as McpToolResult;
  }

  async listResources(): Promise<Array<{ uri: string; name: string }>> {
    const { resources } = await this.#client.listResources();
    return resources;
  }

  async listResourceTemplateUris(): Promise<string[]> {
    const { resourceTemplates } = await this.#client.listResourceTemplates();
    return resourceTemplates.map((template) => template.uriTemplate);
  }

  /** Reads a resource and parses its first JSON contents block. */
  async readResourceJson<T>(uri: string): Promise<T> {
    const { contents } = await this.#client.readResource({ uri });
    const first = contents[0];
    const text = first && 'text' in first ? first.text : '{}';
    return JSON.parse(String(text)) as T;
  }

  async listPromptNames(): Promise<string[]> {
    const { prompts } = await this.#client.listPrompts();
    return prompts.map((prompt) => prompt.name);
  }

  /** Raw content blocks of a tool call — for resource_link assertions. */
  async callToolBlocks(
    name: string,
    args: Record<string, unknown>
  ): Promise<
    Array<{ type: string; text?: string; uri?: string; annotations?: unknown }>
  > {
    const result = await this.callTool(name, args);
    return result.content as Array<{
      type: string;
      text?: string;
      uri?: string;
      annotations?: unknown;
    }>;
  }

  async close(): Promise<void> {
    await this.#client.close();
    await this.#transport.close();
  }
}

/**
 * First content block of a tool result is always the JSON payload (recall and
 * build_context append a reinforcement footer as a second text block).
 */
export const firstJson = <T>(result: McpToolResult): T =>
  JSON.parse(result.content[0]?.text ?? '{}') as T;

/** All text blocks joined — for contains-style assertions. */
export const contentText = (result: McpToolResult): string =>
  result.content.map((item) => item.text ?? '').join('\n');
