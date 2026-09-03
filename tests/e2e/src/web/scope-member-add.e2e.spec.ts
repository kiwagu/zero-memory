/**
 * Scope membership from /scopes: the admin invites a teammate by email and can
 * revoke that invitation again. A grant no longer takes effect on its own — it
 * is a PENDING invitation until the invitee accepts — so the row the admin sees
 * is labelled as such and carries the address they typed, since a pending
 * invitee's identity deliberately does not resolve for the granter.
 */
import { expect, test } from '@playwright/test';

import { firstJson, McpTestClient } from '../helpers/mcp.js';
import { readSeedState } from '../helpers/runtime-state.js';
import { passwordGrantToken } from '../helpers/users.js';
import { signInThroughForm } from '../helpers/web.js';

test.describe('Scope member management', () => {
  test('admin invites a member by email, then revokes the invitation', async ({
    page,
  }) => {
    const seed = await readSeedState();
    const mcp = await McpTestClient.connect(
      await passwordGrantToken(seed.userA)
    );
    let scope: string;
    try {
      const write = await mcp.callTool('remember', {
        content: 'scope-member marker: add-member flow fact',
        kind: 'fact',
        scope: 'proj.member_add_probe',
      });
      expect(write.isError ?? false).toBe(false);
      scope = firstJson<{ scope: string }>(write).scope;
    } finally {
      await mcp.close();
    }

    await signInThroughForm(page, seed.userA);
    await page.goto('/scopes');

    const card = page.locator('section', { hasText: scope }).first();
    await card.getByPlaceholder('teammate@example.com').fill(seed.userB.email);
    await card.getByRole('button', { name: 'Add member' }).click();

    // The row appears under the address the admin typed — NOT a resolved
    // identity, which the consent model withholds until acceptance — and it
    // says outright that it is pending, so the admin is never left believing
    // access was granted when it was only offered.
    const memberRow = card.locator('li', { hasText: seed.userB.email });
    await expect(memberRow).toBeVisible();
    await expect(memberRow.getByText('reader')).toBeVisible();
    await expect(memberRow.getByText('Pending')).toBeVisible();

    // Revoke it: the confirm dialog fires the delete, the row disappears.
    await memberRow.getByTestId('scope-member-remove').click();
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(card.locator('li', { hasText: seed.userB.email })).toHaveCount(
      0
    );
  });
});
