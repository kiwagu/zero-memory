/**
 * Rule-export formats: render one distilled rule into the on-disk shape each
 * popular agent environment expects. Pure and client-side — the server never
 * writes the user's files; this only prepares the text/filename the owner
 * downloads and drops in themselves.
 *
 * The environments differ in two ways this module encodes:
 *   - frontmatter (Cursor `.mdc` needs `description` + `alwaysApply`; Copilot
 *     `.instructions.md` needs `applyTo`; CLAUDE.md / AGENTS.md are plain
 *     markdown);
 *   - where the file lives (a path hint, split by the personal-vs-project
 *     target layer the incubator derived from the memory scope).
 */

export type RuleExportFormat =
  'claude' | 'cursor' | 'copilot' | 'codex' | 'markdown';

export type RuleExportLayer = 'user' | 'project';

export interface RuleExportInput {
  /** The distilled imperative rule text (markdown). */
  ruleText: string;
  /** Personal vs project layer (drives the path hint / alwaysApply). */
  targetLayer: RuleExportLayer;
  /** Candidate id — makes the downloaded filename unique. */
  id: string;
}

export interface RuleExportFile {
  filename: string;
  content: string;
  mime: string;
}

/** One selectable environment in the download dropdown. */
export interface RuleExportFormatMeta {
  format: RuleExportFormat;
  /** Human label (e.g. "Cursor (.mdc)"). */
  label: string;
  /** Where the file belongs, by layer — shown as a hint. */
  path: Record<RuleExportLayer, string>;
}

/**
 * Ordered registry driving the dropdown. Labels are environment names (not
 * translated — they are product/tool names); the surrounding menu chrome is
 * translated by the caller.
 */
export const RULE_EXPORT_FORMATS: readonly RuleExportFormatMeta[] = [
  {
    format: 'claude',
    label: 'Claude Code (CLAUDE.md)',
    path: {
      user: '~/.claude/CLAUDE.md',
      project: './CLAUDE.md',
    },
  },
  {
    format: 'cursor',
    label: 'Cursor (.mdc)',
    path: {
      user: '~/.cursor/rules/',
      project: '.cursor/rules/',
    },
  },
  {
    format: 'copilot',
    label: 'VS Code · Copilot (.instructions.md)',
    path: {
      user: 'VS Code user settings',
      project: '.github/instructions/',
    },
  },
  {
    format: 'codex',
    label: 'Codex (AGENTS.md)',
    path: {
      user: '~/.codex/AGENTS.md',
      project: './AGENTS.md',
    },
  },
  {
    format: 'markdown',
    label: 'Raw markdown (.md)',
    path: {
      user: 'anywhere',
      project: 'anywhere',
    },
  },
] as const;

const MARKDOWN_MIME = 'text/markdown';
const DESCRIPTION_MAX = 100;

/** Short slug of the candidate id for a filename (strip the entity prefix dot). */
const idSlug = (id: string): string => id.replace(/\./g, '-');

/**
 * A one-line description for frontmatter: the rule's first sentence, trimmed
 * and bounded. Frontmatter breaks on a stray newline, so it is single-line.
 */
export const ruleDescription = (ruleText: string): string => {
  const firstSentence = ruleText.trim().split(/(?<=[.!?])\s|\n/)[0] ?? '';
  const oneLine = firstSentence.replace(/\s+/g, ' ').trim();
  const bounded =
    oneLine.length > DESCRIPTION_MAX
      ? `${oneLine.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`
      : oneLine;
  // YAML plain scalars choke on a leading/# etc.; quote defensively.
  return bounded.replace(/"/g, "'");
};

const pathHint = (meta: RuleExportFormatMeta, layer: RuleExportLayer): string =>
  meta.path[layer];

const RENDERERS: Record<
  RuleExportFormat,
  (input: RuleExportInput, body: string, hint: string) => RuleExportFile
> = {
  claude: (input, body, hint) => ({
    filename: `zm-rule-${idSlug(input.id)}.CLAUDE.md`,
    content: `<!-- zero-memory rule — paste into ${hint} -->\n\n${body}\n`,
    mime: MARKDOWN_MIME,
  }),
  cursor: (input, body) => ({
    filename: `zm-rule-${idSlug(input.id)}.mdc`,
    content:
      `---\n` +
      `description: "${ruleDescription(body)}"\n` +
      `alwaysApply: true\n` +
      `---\n\n${body}\n`,
    mime: MARKDOWN_MIME,
  }),
  copilot: (input, body) => ({
    filename: `zm-rule-${idSlug(input.id)}.instructions.md`,
    content: `---\napplyTo: "**"\n---\n\n${body}\n`,
    mime: MARKDOWN_MIME,
  }),
  codex: (input, body, hint) => ({
    filename: `zm-rule-${idSlug(input.id)}.AGENTS.md`,
    content: `<!-- zero-memory rule — paste into ${hint} -->\n\n${body}\n`,
    mime: MARKDOWN_MIME,
  }),
  markdown: (input, body) => ({
    filename: `zm-rule-${idSlug(input.id)}.md`,
    content: `${body}\n`,
    mime: MARKDOWN_MIME,
  }),
};

const META_BY_FORMAT = new Map(
  RULE_EXPORT_FORMATS.map((meta) => [meta.format, meta])
);

/** Render one rule into the on-disk file for the chosen environment. */
export const renderRuleFile = (
  format: RuleExportFormat,
  input: RuleExportInput
): RuleExportFile => {
  const meta = META_BY_FORMAT.get(format);
  if (!meta) {
    throw new Error(`unknown rule export format: ${format}`);
  }
  const body = input.ruleText.trim();
  return RENDERERS[format](input, body, pathHint(meta, input.targetLayer));
};
