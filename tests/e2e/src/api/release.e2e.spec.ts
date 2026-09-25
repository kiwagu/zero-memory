import { expect, test } from '@playwright/test';

import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

test.describe('Releases over MCP', () => {
  test('an admin configures a project, a release lands on the card it carries, and the card reads it back', async () => {
    const seed = await readSeedState();
    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const scope = firstJson<{ scope: string }>(
        await agent.callTool('remember', {
          content: `e2e release marker ${Date.now()}: the edge proxy drops long polls`,
          kind: 'fact',
          project_hint: `/tmp/zm-e2e-release-${Date.now()}`,
        })
      ).scope;

      const configured = await agent.callTool('release', {
        action: 'configure',
        scope,
        version_url: 'https://api.example.com/healthz',
      });
      expect(configured.isError ?? false).toBe(false);
      expect(
        firstJson<{ settings: { on_release: string } }>(configured).settings
          .on_release
      ).toBe('record');

      const card = firstJson<{ card: { id: string; number: number } }>(
        await agent.callTool('card', {
          action: 'create',
          no_links: 'e2e fixture',
          scope,
          title: 'Ship the proxy fix',
          state: 'active',
          branch: { repo: 'acme/memory-service', name: 'feature/proxy' },
        })
      ).card;
      await agent.callTool('card', {
        action: 'land',
        card_id: card.id,
        branch: { repo: 'acme/memory-service', name: 'feature/proxy' },
        squash_sha: 'aaaaaaa',
        target: 'main',
        reason: 'gate green',
      });

      const candidates = firstJson<{ cards: Array<{ id: string }> }>(
        await agent.callTool('release', {
          action: 'candidates',
          scope,
          version: '1.0.0',
        })
      );
      expect(candidates.cards.map((c) => c.id)).toEqual([card.id]);

      const recorded = firstJson<{
        recorded: string[];
        release: { first_observed: boolean };
      }>(
        await agent.callTool('release', {
          action: 'record',
          scope,
          version: '1.0.0',
          build: 'abc1234',
          release_commit: 'bbbbbbb',
          source: 'url',
          card_ids: [card.id],
        })
      );
      expect(recorded.recorded).toEqual([card.id]);

      const read = firstJson<{ releases: Array<{ version: string }> }>(
        await agent.callTool('board', { action: 'get', card_id: card.id })
      );
      expect(read.releases.map((r) => r.version)).toEqual(['1.0.0']);

      // A release with no `build` (e.g. a tag-sourced one) must still
      // record: the store's p_build has no default, so it must always be
      // sent — even as null — never merely omitted from the RPC call.
      const secondCard = firstJson<{ card: { id: string } }>(
        await agent.callTool('card', {
          action: 'create',
          no_links: 'e2e fixture',
          scope,
          title: 'A second card, tag-released with no build',
          state: 'active',
          branch: { repo: 'acme/memory-service', name: 'feature/tagged' },
        })
      ).card;
      await agent.callTool('card', {
        action: 'land',
        card_id: secondCard.id,
        branch: { repo: 'acme/memory-service', name: 'feature/tagged' },
        squash_sha: 'ccccccc',
        target: 'main',
        reason: 'gate green',
      });
      const recordedNoBuild = firstJson<{
        recorded: string[];
        release: { build: string | null };
      }>(
        await agent.callTool('release', {
          action: 'record',
          scope,
          version: '1.1.0',
          release_commit: 'ddddddd',
          source: 'tag',
          card_ids: [secondCard.id],
        })
      );
      expect(recordedNoBuild.recorded).toEqual([secondCard.id]);
      expect(recordedNoBuild.release.build).toBeNull();

      const missing = await agent.callTool('release', {
        action: 'record',
        scope,
        version: '1.0.1',
      });
      expect(missing.isError ?? false).toBe(true);
      expect(contentText(missing)).toMatch(/release_commit/u);
    } finally {
      await agent.close();
    }
  });

  test('a record gives back the landing it checked, and a card that landed again since is skipped', async () => {
    const seed = await readSeedState();
    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const scope = firstJson<{ scope: string }>(
        await agent.callTool('remember', {
          content: `e2e release race marker ${Date.now()}: the cache warms on deploy`,
          kind: 'fact',
          project_hint: `/tmp/zm-e2e-release-race-${Date.now()}`,
        })
      ).scope;
      const branch = { repo: 'acme/memory-service', name: 'feature/warmup' };
      const card = firstJson<{ card: { id: string } }>(
        await agent.callTool('card', {
          action: 'create',
          no_links: 'e2e fixture',
          scope,
          title: 'Warm the cache on deploy',
          state: 'active',
          branch,
        })
      ).card;
      const land = (squash: string) =>
        agent.callTool('card', {
          action: 'land',
          card_id: card.id,
          branch,
          squash_sha: squash,
          target: 'main',
          reason: 'gate green',
        });
      const candidates = async () =>
        firstJson<{ cards: Array<{ id: string; landing_seq: number }> }>(
          await agent.callTool('release', {
            action: 'candidates',
            scope,
            version: '2.0.0',
          })
        ).cards;
      const record = (version: string, landingSeqs: number[]) =>
        agent.callTool('release', {
          action: 'record',
          scope,
          version,
          release_commit: 'aaaaaaa',
          source: 'tag',
          card_ids: [card.id],
          landing_seqs: landingSeqs,
        });

      await land('aaaaaaa');
      const looked = (await candidates())[0]?.landing_seq ?? -1;
      expect(looked).toBeGreaterThan(0);

      const uneven = await record('2.0.0', []);
      expect(uneven.isError ?? false).toBe(true);
      expect(contentText(uneven)).toMatch(/landing_seqs/u);

      // Landed again after the observer looked: the record skips the card.
      await land('bbbbbbb');
      const stale = await record('2.0.0', [looked]);
      expect(stale.isError ?? false).toBe(false);
      expect(firstJson<{ recorded: string[] }>(stale).recorded).toEqual([]);

      const again = await candidates();
      expect(again.map((c) => c.id)).toEqual([card.id]);
      const fresh = await record('2.0.1', [again[0]?.landing_seq ?? -1]);
      expect(firstJson<{ recorded: string[] }>(fresh).recorded).toEqual([
        card.id,
      ]);
    } finally {
      await agent.close();
    }
  });

  test('configure changes only the fields it is given', async () => {
    const seed = await readSeedState();
    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      const scope = firstJson<{ scope: string }>(
        await agent.callTool('remember', {
          content: `e2e release configure marker ${Date.now()}: the batching window is 200ms`,
          kind: 'fact',
          project_hint: `/tmp/zm-e2e-release-configure-${Date.now()}`,
        })
      ).scope;

      const withUrl = await agent.callTool('release', {
        action: 'configure',
        scope,
        version_url: 'https://api.example.com/healthz',
      });
      expect(withUrl.isError ?? false).toBe(false);
      expect(
        firstJson<{ settings: { version_url: string | null } }>(withUrl)
          .settings.version_url
      ).toBe('https://api.example.com/healthz');

      // Only on_release is given: the url must survive untouched.
      const policyOnly = await agent.callTool('release', {
        action: 'configure',
        scope,
        on_release: 'record_and_move_done',
      });
      expect(policyOnly.isError ?? false).toBe(false);
      const afterPolicy = firstJson<{
        settings: { version_url: string | null; on_release: string };
      }>(policyOnly).settings;
      expect(afterPolicy.version_url).toBe('https://api.example.com/healthz');
      expect(afterPolicy.on_release).toBe('record_and_move_done');

      // An explicit null clears the url.
      const cleared = await agent.callTool('release', {
        action: 'configure',
        scope,
        version_url: null,
      });
      expect(cleared.isError ?? false).toBe(false);
      const afterClear = firstJson<{
        settings: { version_url: string | null; on_release: string };
      }>(cleared).settings;
      expect(afterClear.version_url).toBeNull();
      // The policy set by the previous call must still hold.
      expect(afterClear.on_release).toBe('record_and_move_done');
    } finally {
      await agent.close();
    }
  });
});
