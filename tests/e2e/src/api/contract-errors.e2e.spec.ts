/**
 * The published contract surface: the version a client can read off the
 * initialize handshake, and the error taxonomy every tool and owned route
 * answers in. These are the guarantees external clients build against, so the
 * assertions here are deliberately about SHAPE, not prose.
 *
 * The two shapes this suite does NOT unify are asserted elsewhere on purpose:
 * the RFC 6750 Bearer challenge (mcp-tools spec) and the RFC 6749 rate-limit
 * body (oauth spec). Both are parsed by third-party client libraries.
 */
import { expect, test } from '@playwright/test';

import { e2eEnv } from '../helpers/env.js';
import {
  firstJson,
  McpTestClient,
  type McpToolResult,
} from '../helpers/mcp.js';
import { seedReviewConflict } from '../helpers/review.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

const errorOf = (result: McpToolResult): ErrorBody['error'] => {
  expect(result.isError, 'expected a failed tool result').toBe(true);
  return firstJson<ErrorBody>(result).error;
};

test.describe('contract version', () => {
  test('@smoke initialize announces the contract version', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const version = mcp.contractVersion();
      expect(version, 'no contract version on the handshake').toBeDefined();
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      await mcp.close();
    }
  });
});

test.describe('tool error taxonomy', () => {
  test('@smoke a missing resource is not_found', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const error = errorOf(
        await mcp.callTool('get_conflict', {
          dispute_id: '00000000-0000-4000-8000-000000000000',
        })
      );
      expect(error.code).toBe('not_found');
      expect(error.message.length).toBeGreaterThan(0);
    } finally {
      await mcp.close();
    }
  });

  test('@smoke a malformed argument set is validation_failed', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      // Neither `winner` nor `keep_both` — the tool cannot know what to do.
      expect(
        errorOf(
          await mcp.callTool('resolve_conflict', { dispute_id: 'whatever' })
        ).code
      ).toBe('validation_failed');

      // Both modes at once — the bulk tool takes exactly one.
      expect(
        errorOf(
          await mcp.callTool('resolve_conflicts', {
            policy: 'keep_both',
            resolutions: [{ dispute_id: 'whatever' }],
          })
        ).code
      ).toBe('validation_failed');
    } finally {
      await mcp.close();
    }
  });

  test("@smoke another owner's resource is forbidden, not not_found", async () => {
    const seed = await readSeedState();
    // A owns the conflict; B is authenticated but has no claim on it. The
    // refusal must name the reason — B is not being told the row is missing.
    const conflict = await seedReviewConflict(seed.userA);
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const error = errorOf(
        await mcp.callTool('resolve_conflict', {
          dispute_id: conflict.queueId,
          keep_both: true,
        })
      );
      expect(error.code).toBe('forbidden');
    } finally {
      await mcp.close();
    }
  });

  test('@smoke a wrong-state operation is conflict', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      // Restoring a memory that was never invalidated: it exists and it is
      // the caller's, so this is a state refusal, not not_found.
      const liveMemoryId = Object.values(seed.fixtureMemoryIds)[0];
      expect(liveMemoryId, 'no seeded fixture memory to restore').toBeDefined();

      const error = errorOf(
        await mcp.callTool('restore_memory', { memory_id: liveMemoryId })
      );
      expect(error.code).toBe('conflict');
    } finally {
      await mcp.close();
    }
  });
});

test.describe('write-path error taxonomy', () => {
  // The write tools answer with a Result their command handler rethrows. That
  // seam used to drop the failure's class, so every rejection an agent could
  // have fixed itself arrived as `internal` — "nothing you can do" — and,
  // over HTTP, as a 500. These assertions pin the class at the boundary the
  // client actually reads.
  test('@smoke a rejected secret is validation_failed, not internal', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const error = errorOf(
        await mcp.callTool('remember', {
          content:
            'deploy runs with ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA on the runner',
          scope: 'personal',
        })
      );
      expect(error.code).toBe('validation_failed');
      // The message is the agent's course-correction and must survive the
      // throw — and must never echo the secret back.
      expect(error.message).toContain('secret_content_rejected');
      expect(error.message).not.toContain(
        'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      );
    } finally {
      await mcp.close();
    }
  });

  test('@smoke closing a memory that is not a loop is validation_failed', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const regularMemoryId = Object.values(seed.fixtureMemoryIds)[0];
      expect(regularMemoryId, 'no seeded fixture memory').toBeDefined();

      const error = errorOf(
        await mcp.callTool('close_loop', { memory_id: regularMemoryId })
      );
      expect(error.code).toBe('validation_failed');
      expect(error.message).toContain('not an open loop');
    } finally {
      await mcp.close();
    }
  });

  test('@smoke forgetting a memory that does not exist is not_found', async () => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const error = errorOf(
        await mcp.callTool('forget', {
          // Syntactically valid (Crockford base32, 16 + 10) but never issued,
          // so the tool reaches the lookup instead of failing input parsing.
          memory_id: 'mem_zzzzzzzzzzzzzzzz.0000000000',
        })
      );
      expect(error.code).toBe('not_found');
    } finally {
      await mcp.close();
    }
  });
});

test.describe('HTTP error taxonomy', () => {
  test('@smoke an unmatched route answers in the taxonomy', async ({
    request,
  }) => {
    const response = await request.get(
      `${e2eEnv.serverUrl}/no-such-route-exists`
    );
    expect(response.status()).toBe(404);
    expect(response.headers()['content-type']).toContain('application/json');
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe('not_found');
    expect(typeof body.error.message).toBe('string');
  });
});
