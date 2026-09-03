import { describe, expect, it } from 'vitest';

import { detectSecrets, guardMemoryWrite } from './content-guard.js';

/** A representative full-length fake per known secret format. */
const SECRET_SAMPLES: Array<{ detector: string; text: string }> = [
  {
    detector: 'pem-private-key',
    text: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow…\n-----END RSA PRIVATE KEY-----',
  },
  {
    detector: 'github-token',
    text: 'deploy uses ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA for pushes',
  },
  {
    detector: 'github-token',
    text: 'token github_pat_11AAAAAAA0AAAAAAAAAAAA_AAAAAAAAAA works',
  },
  {
    detector: 'aws-access-key-id',
    text: 'the ci user is AKIAIOSFODNN7EXAMPLE',
  },
  {
    detector: 'slack-token',
    text: 'bot posts with xoxb-1234567890-abcdefghij',
  },
  {
    detector: 'jwt',
    text: 'session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  },
  {
    detector: 'url-credentials',
    text: 'connect via postgres://zm:sup3rs3cret@db.internal:5432/zm',
  },
  {
    detector: 'anthropic-api-key',
    text: 'extractor key sk-ant-api03-AAAAAAAAAAAAAAAAAAAA',
  },
  {
    detector: 'openai-api-key',
    text: 'fallback model key sk-proj4AAAAAAAAAAAAAAAAAAAA',
  },
  {
    detector: 'stripe-api-key',
    text: 'billing uses sk_live_AAAAAAAAAAAAAAAA',
  },
  {
    detector: 'google-api-key',
    text: 'maps key AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  },
];

/** Legitimate memory content that must never be rejected. */
const CLEAN_SAMPLES: string[] = [
  // Own identifier and digest formats — the reason entropy scoring is out.
  'superseded by mem_x0qf53wy8ey3et81.01kwvfprfj after the hygiene pass',
  'source hash sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  // Truncated token mentions in prose.
  'GitHub tokens start with ghp_ and must never be committed',
  'a JWT looks like eyJhbGciOi… (three dot-separated segments)',
  // URLs without a password.
  'the stack listens on postgres://db.internal:5432/zm',
  'docs live at https://user@example.com/path',
  // PII stays allowed in v1 (git config, team contacts).
  'reach the owner at kiwagu@example.com',
  'password rotation policy is quarterly',
];

describe('detectSecrets', () => {
  for (const { detector, text } of SECRET_SAMPLES) {
    it(`detects ${detector} in "${text.slice(0, 40)}…"`, () => {
      const findings = detectSecrets(text, 'content');
      expect(findings.map((finding) => finding.detector)).toContain(detector);
    });
  }

  for (const text of CLEAN_SAMPLES) {
    it(`passes clean content "${text.slice(0, 40)}…"`, () => {
      expect(detectSecrets(text, 'content')).toEqual([]);
    });
  }

  it('masks the sample so the secret never echoes back', () => {
    const [finding] = detectSecrets(
      'key sk-ant-api03-AAAAAAAAAAAAAAAAAAAA',
      'content'
    );
    expect(finding!.sample).toBe('sk-ant…');
    expect(finding!.sample).not.toContain('api03');
  });
});

describe('guardMemoryWrite', () => {
  it('passes a clean write covering all fields', () => {
    expect(
      guardMemoryWrite({
        content: 'prefer bun over npm',
        verbatim: 'npmの代わりにbun',
        source: { kind: 'import', path: '/notes/CLAUDE.md', nested: [1, 'a'] },
      })
    ).toBeNull();
  });

  it('rejects a secret in the verbatim idiom anchor', () => {
    const finding = guardMemoryWrite({
      content: 'the deploy token was rotated',
      verbatim: 'トークン ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(finding?.field).toBe('verbatim');
    expect(finding?.detector).toBe('github-token');
  });

  it('rejects a secret smuggled as an entity-mention name', () => {
    const finding = guardMemoryWrite({
      content: 'the ci workflow publishes the package',
      entityNames: ['ci workflow', `ghp_${'A'.repeat(36)}`],
    });
    expect(finding?.field).toBe('entities[1].name');
    expect(finding?.detector).toBe('github-token');
  });

  it('rejects a secret in a nested provenance source string leaf', () => {
    const finding = guardMemoryWrite({
      content: 'imported from a notes file',
      source: {
        kind: 'import',
        extra: { dsn: 'postgres://zm:sup3rs3cret@db.internal/zm' },
      },
    });
    expect(finding?.field).toBe('source.extra.dsn');
    expect(finding?.detector).toBe('url-credentials');
  });
});
