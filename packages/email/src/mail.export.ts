#!/usr/bin/env bun
/**
 * Exports the authentication templates to static HTML and verifies the wiring.
 *
 * One artifact, three consumers — the reason this is a script and not a mount:
 *   - the Supabase CLI stacks (dev and the e2e stand) read the file through
 *     `[auth.email.template.*] content_path`, which the CLI resolves relative
 *     to the directory holding `supabase/config.toml` and serves to GoTrue over
 *     an internal URL;
 *   - a self-hosted stack points `GOTRUE_MAILER_TEMPLATES_*` at the path under
 *     `SITE_URL` where the dashboard serves the very same file, because GoTrue
 *     fetches templates over HTTP and cannot read a mounted file;
 *   - a hosted Supabase project gets the same HTML pasted into its Auth
 *     settings by hand.
 *
 * `--check` re-renders and compares against what is committed, so a template
 * edited without exporting (or a subject changed in one place only) fails a
 * gate instead of shipping a stale email.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { MAIL_LOCALES, type MailLocale } from '@workspace/i18n-catalogs';

import { AUTH_TEMPLATES } from './auth-template.registry.js';
import { renderAuthTemplate } from './mail.render.js';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/**
 * Committed under the dashboard's static assets: that is what lets the
 * self-hosted stack fetch them from `SITE_URL` without another container. The
 * templates carry no secrets — GoTrue substitutes the variables at send time.
 */
const OUTPUT_DIR = join(repoRoot, 'apps/web/public/email-templates');
const URL_PREFIX = '/email-templates';
const MANIFEST_FILE = 'manifest.json';

/** Every Supabase CLI stack whose config must point at the exported files. */
const CONFIG_TARGETS = [
  {
    label: 'dev stack',
    configPath: join(repoRoot, 'supabase/config.toml'),
    baseDir: repoRoot,
  },
  {
    label: 'e2e stand',
    configPath: join(repoRoot, 'tests/e2e/supabase/config.toml'),
    baseDir: join(repoRoot, 'tests/e2e'),
  },
] as const;

/**
 * The self-hosted stack's wiring, which is env rather than config: GoTrue there
 * fetches templates over HTTP, so the overlay carries URLs and subjects.
 */
const MAIL_OVERLAY_PATH = join(
  repoRoot,
  'infra/prod/docker-compose.supabase-mail.yml'
);

type ExportedTemplate = {
  name: string;
  locale: MailLocale;
  subject: string;
  file: string;
  urlPath: string;
};

type TemplateManifest = {
  /** How to regenerate; kept in the artifact so nobody has to go looking. */
  command: string;
  templates: ExportedTemplate[];
};

function fileNameFor(name: string, locale: MailLocale): string {
  return `${name}.${locale}.html`;
}

async function renderAll(): Promise<
  { entry: ExportedTemplate; html: string }[]
> {
  const rendered: { entry: ExportedTemplate; html: string }[] = [];
  for (const locale of MAIL_LOCALES) {
    for (const spec of AUTH_TEMPLATES) {
      const result = await renderAuthTemplate(spec, locale);
      const file = fileNameFor(spec.name, locale);
      rendered.push({
        entry: {
          name: spec.name,
          locale,
          subject: result.subject,
          file,
          urlPath: `${URL_PREFIX}/${file}`,
        },
        html: result.html,
      });
    }
  }
  return rendered;
}

function buildManifest(entries: ExportedTemplate[]): string {
  const manifest: TemplateManifest = {
    command: 'bun run --cwd packages/email mail:export',
    templates: entries,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

type ConfigIssue = { target: string; problem: string };

/**
 * Verifies that each CLI stack's config points at the exported file and carries
 * the catalog's subject. A subject retyped into config drifts silently: the
 * email body would be ours while the subject line stayed whatever was pasted
 * months ago.
 */
async function checkConfigWiring(
  entries: ExportedTemplate[]
): Promise<ConfigIssue[]> {
  const issues: ConfigIssue[] = [];
  const defaultLocale = MAIL_LOCALES[0];

  for (const target of CONFIG_TARGETS) {
    const raw = await readIfPresent(target.configPath);
    if (raw === null) {
      issues.push({ target: target.label, problem: 'config.toml not found' });
      continue;
    }

    const parsed = Bun.TOML.parse(raw) as {
      auth?: { email?: { template?: Record<string, unknown> } };
    };
    const templates = parsed.auth?.email?.template ?? {};

    for (const entry of entries.filter((e) => e.locale === defaultLocale)) {
      const section = templates[entry.name] as
        { subject?: string; content_path?: string } | undefined;

      if (!section) {
        issues.push({
          target: target.label,
          problem: `[auth.email.template.${entry.name}] is missing`,
        });
        continue;
      }
      if (section.subject !== entry.subject) {
        issues.push({
          target: target.label,
          problem: `${entry.name}: subject is "${section.subject ?? ''}", catalog says "${entry.subject}"`,
        });
      }
      const expected = join(OUTPUT_DIR, entry.file);
      const actual = section.content_path
        ? resolve(target.baseDir, section.content_path)
        : '';
      if (actual !== expected) {
        issues.push({
          target: target.label,
          problem: `${entry.name}: content_path resolves to "${actual}", expected "${expected}"`,
        });
      }
    }
  }

  return issues;
}

/**
 * Same drift question for the self-hosted stack, asked of text rather than
 * parsed config: the overlay is YAML with `${VAR:-}` interpolation, and matching
 * the two lines we generate is both sufficient and immune to formatting.
 */
async function checkOverlayWiring(
  entries: ExportedTemplate[]
): Promise<ConfigIssue[]> {
  const issues: ConfigIssue[] = [];
  const raw = await readIfPresent(MAIL_OVERLAY_PATH);
  if (raw === null) {
    return [{ target: 'self-hosted overlay', problem: 'file not found' }];
  }

  for (const entry of entries.filter((e) => e.locale === MAIL_LOCALES[0])) {
    const envName = entry.name.toUpperCase();
    if (!raw.includes(`GOTRUE_MAILER_TEMPLATES_${envName}:`)) {
      issues.push({
        target: 'self-hosted overlay',
        problem: `GOTRUE_MAILER_TEMPLATES_${envName} is missing`,
      });
    } else if (!raw.includes(`${URL_PREFIX}/${entry.file}`)) {
      issues.push({
        target: 'self-hosted overlay',
        problem: `GOTRUE_MAILER_TEMPLATES_${envName} does not point at ${URL_PREFIX}/${entry.file}`,
      });
    }
    if (!raw.includes(`GOTRUE_MAILER_SUBJECTS_${envName}: ${entry.subject}`)) {
      issues.push({
        target: 'self-hosted overlay',
        problem: `GOTRUE_MAILER_SUBJECTS_${envName} is missing or differs from the catalog subject "${entry.subject}"`,
      });
    }
  }

  return issues;
}

async function runExport(): Promise<void> {
  const rendered = await renderAll();
  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const { entry, html } of rendered) {
    await writeFile(join(OUTPUT_DIR, entry.file), html, 'utf8');
  }
  await writeFile(
    join(OUTPUT_DIR, MANIFEST_FILE),
    buildManifest(rendered.map((r) => r.entry)),
    'utf8'
  );

  console.log(
    `[mail] exported ${rendered.length} template(s) to ${OUTPUT_DIR}`
  );
  for (const { entry } of rendered) {
    console.log(`[mail]   ${entry.file} — ${entry.subject}`);
  }
}

async function runCheck(): Promise<void> {
  const rendered = await renderAll();
  const problems: string[] = [];

  for (const { entry, html } of rendered) {
    const onDisk = await readIfPresent(join(OUTPUT_DIR, entry.file));
    if (onDisk === null) {
      problems.push(`${entry.file} is missing`);
    } else if (onDisk !== html) {
      problems.push(`${entry.file} is stale`);
    }
  }

  const manifestOnDisk = await readIfPresent(join(OUTPUT_DIR, MANIFEST_FILE));
  const expectedManifest = buildManifest(rendered.map((r) => r.entry));
  if (manifestOnDisk !== expectedManifest) {
    problems.push(`${MANIFEST_FILE} is stale or missing`);
  }

  const entries = rendered.map((r) => r.entry);
  for (const issue of [
    ...(await checkConfigWiring(entries)),
    ...(await checkOverlayWiring(entries)),
  ]) {
    problems.push(`${issue.target}: ${issue.problem}`);
  }

  if (problems.length > 0) {
    console.error('[mail] export is out of date:');
    for (const problem of problems) {
      console.error(`[mail]   ${problem}`);
    }
    console.error('[mail] run: bun run --cwd packages/email mail:export');
    process.exit(1);
  }

  console.log(
    `[mail] ${rendered.length} template(s) match the committed export, and every stack is wired to them`
  );
}

if (process.argv.includes('--check')) {
  await runCheck();
} else {
  await runExport();
}
