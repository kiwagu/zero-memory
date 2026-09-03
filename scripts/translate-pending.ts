/**
 * Drains the language-canonicalization queue: classifies not-yet-translated
 * memories (English -> 'skipped', other -> 'pending') and translates the
 * pending ones into canonical English, preserving the original and re-embedding.
 *
 * This is the one-time backlog drain and the primitive the nightly cron also
 * calls. Run a dry run FIRST to preview how many rows would change before
 * spending any tokens:
 *
 *   # preview only — no model call, no writes
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     bun scripts/translate-pending.ts --dry-run
 *
 *   # classify only (model-free), then inspect before translating
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     bun scripts/translate-pending.ts --classify
 *
 *   # full pass: classify + translate (needs the model, unless deterministic)
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… ANTHROPIC_API_KEY=… \
 *     bun scripts/translate-pending.ts
 *
 * Flags: --dry-run (preview), --classify (classify only), --translate
 * (translate only). ZM_EXTRACTOR=deterministic uses the no-op translator (no
 * API key), matching the extractor wiring.
 */
// Relative import into the package source: this script lives at the repo root,
// which does not depend on @workspace/translation, so the bare specifier does
// not resolve. The package's own internal imports still resolve from its own
// location.
import {
  LlmTranslator,
  TranslationWorker,
} from '../packages/translation/src/index.js';
import { DeterministicTranslator } from '../packages/translation/src/testing/index.js';

const args = new Set(Bun.argv.slice(2));
const dryRun = args.has('--dry-run');
const classifyOnly = args.has('--classify');
const translateOnly = args.has('--translate');

const translator =
  process.env.ZM_EXTRACTOR === 'deterministic'
    ? new DeterministicTranslator()
    : // Built by hand rather than through the container, so no usage recorder
      // is passed: this pass is not metered, which the class documents as the
      // right failure for a one-shot and the wrong one for the server.
      new LlmTranslator();
const worker = new TranslationWorker(translator);

const report: Record<string, unknown> = { dryRun };

if (!translateOnly) {
  report.classify = await worker.classify({ dryRun });
}
if (!classifyOnly) {
  report.translate = await worker.translate({ dryRun });
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
