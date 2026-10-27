/**
 * Backfill of `applies_when` for promoted rules that have none: the rule gate
 * judges a task against a rule's condition, and rules promoted before the
 * distiller wrote one carry only their text. Each drafted condition is stored
 * on the rule and printed; the owner reviews and edits it on /rules, where the
 * condition is editable in place. A rule the model says binds every task is
 * left without one.
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… ANTHROPIC_API_KEY=… \
 *     bun run rules:applies-when-draft -- --owner usr_… --max 50   # from apps/server
 *
 * Point it at a stand (the e2e stack, or a production clone restored into the
 * preview stand), never at hosted production: it writes.
 */
import { entityIdSchemas } from '@workspace/contracts';
import { container } from '@workspace/di';
import { AppliesWhenDrafter } from '@workspace/hygiene';
import { createServiceRoleClient } from '@workspace/persistence';

import { register } from './registry/index.js';

// The drafter calls the LLM gateway, which only the composition root installs.
register(container);

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};

const owner = flag('owner');
if (!owner || !entityIdSchemas.user.is(owner)) {
  console.error(
    `--owner must be a user id (usr_<rand16>.<ts10>), got ${String(owner)}`
  );
  process.exit(1);
}
const rawMax = flag('max');
const max = Number(rawMax ?? 50);
if (!Number.isInteger(max) || max <= 0) {
  console.error(`--max must be a positive integer (got ${String(rawMax)})`);
  process.exit(1);
}

const client = createServiceRoleClient();
const { data: rows, error } = await client
  .from('rule_candidates')
  .select('id, rule_text, memories!inner(owner_id)')
  .eq('status', 'promoted')
  .is('revoked_at', null)
  .is('applies_when', null)
  .not('rule_text', 'is', null)
  .eq('memories.owner_id', owner)
  .order('promoted_at', { ascending: false })
  .limit(max);
if (error) throw new Error(error.message);

const drafter = new AppliesWhenDrafter();
let drafted = 0;
for (const row of rows ?? []) {
  const draft = await drafter.draft(row.rule_text as string, owner);
  if (!draft.applies_when) continue;
  const { error: upErr } = await client
    .from('rule_candidates')
    .update({ applies_when: draft.applies_when })
    .eq('id', row.id);
  if (upErr) throw new Error(upErr.message);
  drafted += 1;
  console.log(`${row.id}: ${draft.applies_when}`);
}
console.log(
  `applies_when drafted for ${drafted} of ${rows?.length ?? 0} rules; review them on /rules`
);
