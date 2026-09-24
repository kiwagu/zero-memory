import { z } from 'zod';

import {
  cardIdSchema,
  cardStateSchema,
  gitCommitShaSchema,
} from './card.schema.js';

/** The version a production state is known by: semver-like, no leading `v`. */
export const releaseVersionSchema = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u, {
    message: 'A version is letters, digits, dots, dashes and underscores',
  });

/** Where a project's production state lives, and what a release does. */
export const releaseSettingsSchema = z.object({
  scope: z.string(),
  version_url: z.string().nullable(),
  version_field: z.string(),
  tag_template: z.string(),
  tag_pattern: z.string(),
  on_release: z.enum(['record', 'record_and_move_done']),
  updated_at: z.string(),
});
export type ReleaseSettings = z.infer<typeof releaseSettingsSchema>;

export const releaseLandingSchema = z.object({
  repo: z.string(),
  branch: z.string(),
  squash_sha: z.string(),
});

/** A card a production state could carry: it landed, and has no record of this state yet. */
export const releaseCandidateSchema = z.object({
  id: cardIdSchema,
  number: z.number().int().positive(),
  title: z.string(),
  state: cardStateSchema,
  landings: z.array(releaseLandingSchema).default([]),
});
export type ReleaseCandidate = z.infer<typeof releaseCandidateSchema>;

export const observedReleaseSchema = z.object({
  version: z.string(),
  build: z.string().nullable(),
  release_commit: z.string(),
  source: z.enum(['url', 'tag']),
  observed_at: z.string(),
  first_observed: z.boolean(),
});
export type ObservedRelease = z.infer<typeof observedReleaseSchema>;

/**
 * One flat object, like the card tool's: the MCP server registers the input's
 * `.shape`, which a discriminated union does not have. Which fields an action
 * needs is checked by the handler.
 */
export const releaseInputSchema = z.object({
  action: z
    .enum(['settings', 'configure', 'candidates', 'record'])
    .describe(
      'settings: read where the production state lives. configure: set it ' +
        '(project admin). candidates: the landed cards with no record of a ' +
        'version. record: write a production state and the cards it carries.'
    ),
  scope: z.string().min(1).describe('Which project board.'),
  version_url: z
    .string()
    .url()
    .nullable()
    .optional()
    .describe(
      'For configure: where the running version is read, e.g. the server root ' +
        '/healthz. https only (http for localhost), no credentials — every ' +
        'member of the project reads it. Omit or null when the project never ' +
        'deploys: its release tags are its state.'
    ),
  version_field: z
    .string()
    .optional()
    .describe(
      'For configure: the JSON field holding the version. Default "version".'
    ),
  tag_template: z
    .string()
    .optional()
    .describe('For configure: version to tag. Default "v{version}".'),
  tag_pattern: z
    .string()
    .optional()
    .describe('For configure: which tags are releases. Default "v*".'),
  on_release: z
    .enum(['record', 'record_and_move_done'])
    .optional()
    .describe(
      'For configure. record (default): a release is written on each card it ' +
        'carries. record_and_move_done: it also moves the carried waiting cards to done.'
    ),
  version: releaseVersionSchema
    .optional()
    .describe('For candidates and record: the version, without a leading v.'),
  build: z
    .string()
    .nullable()
    .optional()
    .describe('For record: what the url reported after "+".'),
  release_commit: gitCommitShaSchema
    .optional()
    .describe(
      'For record: the commit the version resolved to through its tag.'
    ),
  source: z
    .enum(['url', 'tag'])
    .optional()
    .describe('For record: where the state was read.'),
  card_ids: z
    .array(cardIdSchema)
    .max(500)
    .optional()
    .describe('For record: the cards the state carries.'),
  thread: z.string().optional(),
  agent_label: z.string().max(80).optional(),
});
export type ReleaseInput = z.infer<typeof releaseInputSchema>;

export const releaseOutputSchema = z.object({
  settings: releaseSettingsSchema.nullable().optional(),
  cards: z.array(releaseCandidateSchema).optional(),
  release: observedReleaseSchema.optional(),
  recorded: z.array(cardIdSchema).optional(),
  moved: z.array(cardIdSchema).optional(),
});
export type ReleaseOutput = z.infer<typeof releaseOutputSchema>;
