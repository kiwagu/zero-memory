// Types only: the dashboard loads this module on its own through the
// `@workspace/memory/content-guard` subpath, which must stay free of runtime
// imports (the package root loads the DI container).
import type { SecretDetectorId, SecretFinding } from '@workspace/contracts';

/**
 * Deterministic secret detectors: known credential formats only, no entropy
 * scoring. The corpus legitimately contains high-entropy identifiers
 * (`mem_…` ids, sha256 digests), so a generic entropy detector would reject
 * valid memories; unknown-format secrets stay a prompt-level ban.
 */
interface SecretDetector {
  id: SecretDetectorId;
  pattern: RegExp;
}

// Order matters only where prefixes overlap: the Anthropic detector must run
// before the generic OpenAI `sk-` one (excluded there via a lookahead anyway).
const DETECTORS: readonly SecretDetector[] = [
  {
    id: 'pem-private-key',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
  },
  {
    id: 'github-token',
    // Classic tokens (ghp_/gho_/ghu_/ghs_/ghr_, 36+ chars) and fine-grained
    // github_pat_ tokens.
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
  },
  {
    id: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    id: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    id: 'jwt',
    // Three base64url segments; a truncated mention ("eyJ…") does not match.
    pattern: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/,
  },
  {
    id: 'url-credentials',
    // Any scheme with user:password@ — postgres://, mysql://, redis://,
    // amqp://, mongodb://, https://… A URL without a password does not match.
    pattern: /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/]{1,64}:[^\s@/]{1,128}@/i,
  },
  {
    id: 'anthropic-api-key',
    pattern: /\bsk-ant-[\w-]{20,}\b/,
  },
  {
    id: 'openai-api-key',
    pattern: /\bsk-(?!ant-)[\w-]{20,}\b/,
  },
  {
    id: 'stripe-api-key',
    pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  },
  {
    id: 'google-api-key',
    pattern: /\bAIza[\w-]{35}\b/,
  },
];

/** Masks a match so the finding is safe to echo: short prefix + ellipsis. */
const mask = (match: string): string => `${match.slice(0, 6)}…`;

/**
 * Scans one text field for known secret formats. Returns every detector hit
 * with a masked sample; an empty array means the text is clean.
 */
export const detectSecrets = (text: string, field: string): SecretFinding[] => {
  const findings: SecretFinding[] = [];
  for (const detector of DETECTORS) {
    const match = detector.pattern.exec(text);
    if (match) {
      findings.push({
        detector: detector.id,
        field,
        sample: mask(match[0]),
      });
    }
  }
  return findings;
};

/** Collects the string leaves of a jsonb-shaped value as (path, text) pairs. */
const stringLeaves = (
  value: unknown,
  path: string
): Array<{ path: string; text: string }> => {
  if (typeof value === 'string') {
    return [{ path, text: value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      stringLeaves(item, `${path}[${index}]`)
    );
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, nested]) =>
      stringLeaves(nested, `${path}.${key}`)
    );
  }
  return [];
};

/** One free-text field of a write, under the name a rejection reports. */
export interface GuardedText {
  readonly path: string;
  readonly text: string | null | undefined;
}

/**
 * Checks free-text fields for secrets, in order, and returns the first
 * finding (one is enough to reject) or null when every field is clean. An
 * absent or empty field has nothing to check. Every write that persists text
 * a caller typed goes through this: memories, card text, entity names, rule
 * text — a secret refused in one place must not be storable in another.
 */
export const guardTextFields = (
  fields: readonly GuardedText[]
): SecretFinding | null => {
  for (const { path, text } of fields) {
    if (!text) {
      continue;
    }
    const [finding] = detectSecrets(text, path);
    if (finding) {
      return finding;
    }
  }
  return null;
};

/**
 * Guards every text field of a memory write: the content itself, the verbatim
 * idiom anchor, all string leaves of the provenance source descriptor, and
 * the explicit entity-mention names (they land in the entities table, so a
 * secret smuggled as a name would bypass the content check otherwise).
 * Returns the first finding (one is enough to reject) or null when clean.
 */
export const guardMemoryWrite = (write: {
  content: string;
  verbatim?: string | null;
  source?: Record<string, unknown> | null;
  entityNames?: string[];
}): SecretFinding | null =>
  guardTextFields([
    { path: 'content', text: write.content },
    { path: 'verbatim', text: write.verbatim },
    ...(write.source ? stringLeaves(write.source, 'source') : []),
    ...(write.entityNames ?? []).map((name, index) => ({
      path: `entities[${index}].name`,
      text: name,
    })),
  ]);
