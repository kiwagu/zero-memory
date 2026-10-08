/**
 * `check-mdx` — compiles every documentation page and fails on the first
 * class of defect the site build would otherwise meet only at release time.
 * Runs inside the docs package's typecheck, so `bun run check` carries it.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { checkDocsPage, type MdxProblem } from '../lib/mdx-check.js';

// The content tree the site serves (see source.config.ts): the repository's
// own `docs/` folder.
const docsDir = join(import.meta.dirname, '..', '..', '..', 'docs');

const pages = (await readdir(docsDir, { recursive: true }))
  .filter((file) => file.endsWith('.mdx') || file.endsWith('.md'))
  .sort();

// A gate that finds nothing to check must not pass: a moved folder would
// otherwise turn this into a check that can never fail.
if (pages.length === 0) {
  console.error(`check-mdx: no pages found under ${docsDir}`);
  process.exit(1);
}

const problems: MdxProblem[] = [];
for (const page of pages) {
  const path = join(docsDir, page);
  const problem = await checkDocsPage(path, await readFile(path, 'utf8'));
  if (problem) {
    problems.push(problem);
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(
      `${relative(process.cwd(), problem.path)}:${problem.line ?? '?'}:` +
        `${problem.column ?? '?'}  ${problem.message}`
    );
  }
  console.error(
    `check-mdx: ${problems.length} of ${pages.length} page(s) do not compile`
  );
  process.exit(1);
}

console.log(`check-mdx: ok (${pages.length} page(s))`);
