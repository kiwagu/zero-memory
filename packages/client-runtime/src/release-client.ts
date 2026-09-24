import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  type DeployedVersion,
  isReleaseUrl,
  parseDeployedVersion,
} from '@workspace/client-core';
import {
  type ReleaseInput,
  type ReleaseOutput,
  releaseOutputSchema,
} from '@workspace/contracts';
import { createAuthedTransport } from '@workspace/mcp-oauth-client';

import { resolveServerUrl } from './server-config.js';
import { parseToolPayload, toolErrorMessage } from './tool-result.js';

/**
 * The version a project's url reports, or null — for a url the store's rule
 * would refuse, an error status, a body that is not a version, or no answer
 * by the deadline. Never throws: the caller is a hook.
 */
export const fetchDeployedVersion = async (
  url: string,
  field: string,
  timeoutMs: number
): Promise<DeployedVersion | null> => {
  if (!isReleaseUrl(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Manual, never followed: a project admin's url is read by every
    // member's watcher, so a redirect could make each member's machine GET
    // an address on its own network and publish whatever it answers.
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      redirect: 'manual',
    });
    if (!res.ok) return null;
    return parseDeployedVersion(await res.json(), field);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * One call of the release tool. Bounded like `callCardBranches`: the whole
 * exchange, connecting included, ends at the deadline. A tool error throws,
 * so the caller can tell "the server said no" from an answer.
 */
export const callRelease = async (
  input: ReleaseInput,
  timeoutMs: number,
  serverUrl: string = resolveServerUrl()
): Promise<ReleaseOutput> => {
  const options = { timeout: timeoutMs };
  const client = new Client({ name: 'zero-memory-release', version: '0.1.0' });
  const deadline = setTimeout(() => {
    void client.close().catch(() => undefined);
  }, timeoutMs);
  try {
    await client.connect(createAuthedTransport(serverUrl), options);
    const result = await client.callTool(
      { name: 'release', arguments: input },
      undefined,
      options
    );
    if (result.isError) {
      throw new Error(
        `release ${input.action} failed: ${toolErrorMessage(result)}`
      );
    }
    return releaseOutputSchema.parse(parseToolPayload(result));
  } finally {
    clearTimeout(deadline);
    await client.close().catch(() => undefined);
  }
};
