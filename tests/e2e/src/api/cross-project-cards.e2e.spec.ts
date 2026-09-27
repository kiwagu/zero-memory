/**
 * Work found in one project, filed on another project's board.
 *
 * An agent working in one repository often finds something to fix in a
 * project it only depends on. It names that project the way a person would —
 * in any spelling — and the card lands on that project's board while the
 * conversation stays home. A name only ever points at a project that exists:
 * a misspelt one is refused with the caller's projects, and nothing is
 * created for it.
 */
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import { e2eEnv } from '../helpers/env.js';
import { contentText, firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';

interface Briefed {
  project_scope: string | null;
}

interface Remembered {
  memory_id: string;
  scope: string;
}

interface CardResult {
  card: { id: string; scope: string; number: number };
}

interface BoardResult {
  cards: Array<{ id: string }>;
}

// Unique per attempt: a retry must not meet the first attempt's projects.
const run = () => Date.now().toString(36);

test.describe('Cards across project boards', () => {
  test("a card found in one project lands on another project's board by its name, and the session stays home", async () => {
    const seed = await readSeedState();
    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    const id = run();
    try {
      // The session works in its own project.
      const home = firstJson<Briefed>(
        await agent.callTool('build_context', {
          topic: 'numbat importer',
          project_hint: `/home/someone/repos/numbat-importer-${id}`,
        })
      );
      expect(home.project_scope).toMatch(/numbat_importer/);

      // The project it depends on exists, set up from its repository.
      const upstream = firstJson<Remembered>(
        await agent.callTool('remember', {
          content: `e2e cross-board marker ${id}: the quokka ledger exports CSV`,
          project_hint: `/home/someone/repos/quokka-ledger-${id}`,
        })
      );
      expect(upstream.scope).toMatch(/quokka_ledger/);

      // Filed on the upstream board by name, in the spellings people use.
      const filed: string[] = [];
      for (const name of [
        `Quokka Ledger ${id}`,
        `quokka_ledger_${id}`,
        `QuokkaLedger${id}`,
      ]) {
        const created = await agent.callTool('card', {
          action: 'create',
          project_hint: name,
          title: `The ledger export drops the last row (${name})`,
          no_links: 'e2e fixture',
        });
        expect(created.isError ?? false, contentText(created)).toBe(false);
        const card = firstJson<CardResult>(created).card;
        expect(card.scope).toBe(upstream.scope);
        filed.push(card.id);
      }

      // The upstream board, read by name, holds them.
      const board = firstJson<BoardResult>(
        await agent.callTool('board', {
          action: 'list',
          project_hint: `quokka-ledger-${id}`,
        })
      );
      expect(board.cards.map((card) => card.id)).toEqual(
        expect.arrayContaining(filed)
      );

      // The conversation never moved: its next scope-less writes land home.
      const note = firstJson<Remembered>(
        await agent.callTool('remember', {
          content: `e2e cross-board marker ${id}: the numbat importer reads the ledger CSV`,
        })
      );
      expect(note.scope).toBe(home.project_scope);
      const own = await agent.callTool('card', {
        action: 'create',
        title: 'Read the ledger CSV once its last row is fixed',
        no_links: 'e2e fixture',
      });
      expect(own.isError ?? false, contentText(own)).toBe(false);
      expect(firstJson<CardResult>(own).card.scope).toBe(home.project_scope);
    } finally {
      await agent.close();
    }
  });

  test("a misspelt project name is refused with the caller's projects, and creates nothing", async () => {
    const seed = await readSeedState();
    const token = await passwordGrantToken(seed.userA);
    const agent = await McpTestClient.connect(token);
    const id = run();
    try {
      const upstream = firstJson<Remembered>(
        await agent.callTool('remember', {
          content: `e2e cross-board marker ${id}: the bilby scheduler runs hourly`,
          project_hint: `/home/someone/repos/bilby-scheduler-${id}`,
        })
      );

      const card = await agent.callTool('card', {
        action: 'create',
        project_hint: `bilby-schedular-${id}`,
        title: 'A card aimed at a misspelt project',
        no_links: 'e2e fixture',
      });
      expect(card.isError ?? false).toBe(true);
      expect(contentText(card)).toMatch(/project_hint_unresolvable:/);
      expect(contentText(card)).toContain(upstream.scope);

      const memory = await agent.callTool('remember', {
        content: `e2e cross-board marker ${id}: aimed at a misspelt project`,
        project_hint: `bilby-schedular-${id}`,
      });
      expect(memory.isError ?? false).toBe(true);
      expect(contentText(memory)).toContain(upstream.scope);

      // Neither refusal set up a project for the misspelt name.
      const admin = createClient(
        e2eEnv.supabaseUrl,
        e2eEnv.supabaseServiceRoleKey,
        { auth: { persistSession: false, autoRefreshToken: false } }
      );
      const phantom = upstream.scope.replace(
        /[^.]+$/u,
        `bilby_schedular_${id}`
      );
      const { data, error } = await admin
        .from('scope_members')
        .select('scope')
        .eq('scope', phantom);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    } finally {
      await agent.close();
    }
  });

  test('a card that names no board, from a session with no project, is refused with the projects to choose from', async () => {
    const seed = await readSeedState();
    const setup = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    const id = run();
    let upstream: Remembered;
    try {
      upstream = firstJson<Remembered>(
        await setup.callTool('remember', {
          content: `e2e cross-board marker ${id}: the echidna archive is read-only`,
          project_hint: `/home/someone/repos/echidna-archive-${id}`,
        })
      );
    } finally {
      await setup.close();
    }

    // A fresh connection that never said where it works.
    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    try {
      const card = await agent.callTool('card', {
        action: 'create',
        title: 'A card with nowhere to go',
        no_links: 'e2e fixture',
      });
      expect(card.isError ?? false).toBe(true);
      expect(contentText(card)).toMatch(/scope_target_required:/);
      expect(contentText(card)).toContain(upstream.scope);
    } finally {
      await agent.close();
    }
  });

  test("a teammate's nickname never captures a name meant for your own project, and a teammate's project takes a card by its name", async () => {
    const seed = await readSeedState();
    const id = run();
    const admin = createClient(
      e2eEnv.supabaseUrl,
      e2eEnv.supabaseServiceRoleKey,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const profileOf = async (authUserId: string): Promise<string> => {
      const { data } = await admin
        .from('profiles')
        .select('id')
        .eq('user_id', authUserId)
        .single();
      return (data as { id: string }).id;
    };

    // B owns a project, shares it with A as a writer, and nicknames it QX.
    const owner = await McpTestClient.connect(
      await passwordGrantToken(seed.userB)
    );
    let teammate: Remembered;
    try {
      teammate = firstJson<Remembered>(
        await owner.callTool('remember', {
          content: `e2e cross-board marker ${id}: the ember dunes survey runs weekly`,
          project_hint: `/home/someone/repos/ember-dunes-${id}`,
        })
      );
    } finally {
      await owner.close();
    }
    const joined = await admin.from('scope_members').upsert(
      {
        scope: teammate.scope,
        user_id: await profileOf(seed.userA.id),
        role: 'writer',
        accepted_at: new Date().toISOString(),
      },
      { onConflict: 'scope,user_id' }
    );
    expect(joined.error).toBeNull();
    const aliased = await admin.from('scopes').upsert(
      {
        scope: teammate.scope,
        alias: 'QX',
        created_by: await profileOf(seed.userB.id),
      },
      { onConflict: 'scope' }
    );
    expect(aliased.error).toBeNull();

    const agent = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    try {
      // A's own project, whose initials are QX.
      const own = firstJson<Remembered>(
        await agent.callTool('remember', {
          content: `e2e cross-board marker ${id}: the quiet xenon relay idles overnight`,
          project_hint: `/home/someone/repos/quiet-xenon${id}`,
        })
      );

      // QX fits both: refused with both named, never sent to B's board.
      const squatted = await agent.callTool('card', {
        action: 'create',
        project_hint: 'QX',
        title: 'Meant for my own project',
        no_links: 'e2e fixture',
      });
      expect(squatted.isError ?? false).toBe(true);
      expect(contentText(squatted)).toMatch(/more than one of your projects/);
      expect(contentText(squatted)).toContain(own.scope);
      expect(contentText(squatted)).toContain(teammate.scope);

      // Named by its own name, the teammate's project takes the card.
      const filed = await agent.callTool('card', {
        action: 'create',
        project_hint: `ember-dunes-${id}`,
        title: 'The survey export drops the dune heights',
        no_links: 'e2e fixture',
      });
      expect(filed.isError ?? false, contentText(filed)).toBe(false);
      expect(firstJson<CardResult>(filed).card.scope).toBe(teammate.scope);
    } finally {
      await agent.close();
    }
  });
});
