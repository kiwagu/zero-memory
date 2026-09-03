/**
 * Retro pass over the memory backlog: one bounded batch of the write-time
 * supersede aperture, walked over history instead of the last few days.
 *
 * Why it is a separate entry point rather than part of `hygiene:scan`: the
 * recurring scan is a maintenance tick over what was just written, while this
 * walks a corpus that may be years long. That is a deliberate spend, so it is a
 * deliberate command — explicit batch size, a cursor to resume from, never on a
 * schedule.
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… ANTHROPIC_API_KEY=… \
 *     bun run hygiene:retro -- --max 100                # from apps/server
 *     bun run hygiene:retro -- --max 100 --after 2026-07-01T00:00:00Z
 *     bun run hygiene:retro -- --max 100 --owner usr_…  # one owner only
 *
 * `--offer` switches who judges: instead of the server-side judge it runs no
 * model at all and parks each pair as `unjudged` for the session agent reading
 * the queue. Same pairs, same queue — the difference is only who forms the
 * opinion, and it needs no ANTHROPIC_API_KEY.
 *
 * Everything it finds lands in the review queue either way — the pass never
 * retires a memory on its own. Print the `next cursor` it reports and pass it
 * back as `--after` to continue where the batch stopped; an empty cursor means
 * the corpus is exhausted.
 */
import { HygieneScanner } from '@workspace/hygiene';

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};

const rawMax = flag('max');
const maxSubjects = Number(rawMax ?? 50);
if (!Number.isInteger(maxSubjects) || maxSubjects <= 0) {
  console.error(`--max must be a positive integer (got ${String(rawMax)})`);
  process.exit(1);
}

const startAfter = flag('after');
if (startAfter !== undefined && Number.isNaN(Date.parse(startAfter))) {
  console.error(`--after must be an ISO timestamp (got ${startAfter})`);
  process.exit(1);
}

const offer = process.argv.includes('--offer');

const result = await new HygieneScanner().retroScan({
  maxSubjects,
  ...(offer && { judge: false }),
  ...(startAfter !== undefined && { startAfter }),
  ...(flag('owner') !== undefined && { ownerId: flag('owner') as string }),
});

console.log(`hygiene retro pass (${offer ? 'agent judges' : 'server judges'})`);
console.log(`  subjects walked : ${result.scanned}`);
console.log(`  pairs judged    : ${result.pairsJudged}`);
console.log(`  queued          : ${result.queued}`);
console.log(
  `  next cursor     : ${result.nextCursor ?? '(none — corpus exhausted)'}`
);
if (result.nextCursor) {
  console.log(
    `\ncontinue with: bun run hygiene:retro --${offer ? ' --offer' : ''} --max ${maxSubjects} --after ${result.nextCursor}`
  );
}
