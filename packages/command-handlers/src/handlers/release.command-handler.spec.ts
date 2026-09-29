import {
  ReleaseService,
  type ConfigureReleaseParams,
  type IReleaseRepository,
  type RecordReleaseParams,
} from '@workspace/board';
import { ReleaseCommand } from '@workspace/commands';
import {
  errorCodeOf,
  type ReleaseInput,
  type ReleaseSettings,
} from '@workspace/contracts';
import { Ok } from 'oxide.ts';
import { describe, expect, it } from 'vitest';

import { ReleaseCommandHandler } from './release.command-handler.js';

const CURRENT: ReleaseSettings = {
  scope: 'proj.x',
  version_url: 'https://api.example.com/healthz',
  version_field: 'version',
  tag_template: 'v{version}',
  tag_pattern: 'v*',
  on_release: 'record',
  updated_at: '2026-09-28T00:00:00Z',
};

/** The store behind the service: answers with `current`, remembers writes. */
const storeWith = (current: ReleaseSettings | null) => {
  const configured: ConfigureReleaseParams[] = [];
  const recorded: RecordReleaseParams[] = [];
  const repository: IReleaseRepository = {
    settings: () => Promise.resolve(Ok(current)),
    configure: (params) => {
      configured.push(params);
      return Promise.resolve(Ok(current));
    },
    candidates: () => Promise.resolve(Ok([])),
    record: (params) => {
      recorded.push(params);
      return Promise.resolve(
        Ok({
          release: {
            version: params.version,
            build: params.build,
            release_commit: params.releaseCommit,
            source: params.source,
            observed_at: '2026-09-28T00:00:00Z',
            first_observed: true,
          },
          recorded: params.cardIds,
          moved: [],
        })
      );
    },
  };
  const handler = new ReleaseCommandHandler(new ReleaseService(repository));
  const run = (input: ReleaseInput) =>
    handler.execute(new ReleaseCommand(input));
  return { configured, recorded, run };
};

/** The taxonomy code a rejected call carries. */
const refusalOf = async (call: Promise<unknown>) =>
  errorCodeOf(
    await call.then(
      () => null,
      (error: unknown) => error
    )
  );

const CARD = 'crd_0000000000000023.0000000000' as NonNullable<
  ReleaseInput['card_ids']
>[number];

describe('configure', () => {
  // The store replaces the whole settings row, so every field the call leaves
  // out must be carried over from what the project already has.
  it.each<[string, Partial<ReleaseInput>, Partial<ConfigureReleaseParams>]>([
    [
      'keeps everything it is not given',
      { on_release: 'record_and_move_done' },
      {
        versionUrl: CURRENT.version_url,
        versionField: CURRENT.version_field,
        tagTemplate: CURRENT.tag_template,
        tagPattern: CURRENT.tag_pattern,
        onRelease: 'record_and_move_done',
      },
    ],
    [
      'clears the url only on an explicit null',
      { version_url: null },
      {
        versionUrl: null,
        tagTemplate: CURRENT.tag_template,
        onRelease: CURRENT.on_release,
      },
    ],
    [
      'replaces a field it is given',
      { tag_template: 'release/{version}' },
      {
        versionUrl: CURRENT.version_url,
        tagTemplate: 'release/{version}',
      },
    ],
  ])('%s', async (_name, given, written) => {
    const store = storeWith(CURRENT);

    await store.run({ action: 'configure', scope: 'proj.x', ...given });

    expect(store.configured).toHaveLength(1);
    expect(store.configured[0]).toMatchObject({ scope: 'proj.x', ...written });
  });

  it('on a project with no settings yet, writes only what it was given', async () => {
    const store = storeWith(null);

    await store.run({
      action: 'configure',
      scope: 'proj.x',
      on_release: 'record',
    });

    expect(store.configured).toEqual([
      {
        scope: 'proj.x',
        versionUrl: null,
        versionField: undefined,
        tagTemplate: undefined,
        tagPattern: undefined,
        onRelease: 'record',
      },
    ]);
  });
});

describe('record', () => {
  const release = {
    action: 'record',
    scope: 'proj.x',
    version: '2.0.0',
    release_commit: 'aaaaaaa',
    source: 'tag',
  } as const;

  it('refuses landings that are not one per card, before anything is written', async () => {
    const store = storeWith(CURRENT);

    await expect(
      refusalOf(store.run({ ...release, card_ids: [CARD], landing_seqs: [] }))
    ).resolves.toBe('validation_failed');
    await expect(
      refusalOf(store.run({ ...release, landing_seqs: [7] }))
    ).resolves.toBe('validation_failed');
    expect(store.recorded).toEqual([]);
  });

  it('hands each card its checked landing, in order', async () => {
    const store = storeWith(CURRENT);

    await store.run({ ...release, card_ids: [CARD], landing_seqs: [7] });

    expect(store.recorded).toEqual([
      expect.objectContaining({ cardIds: [CARD], landingSeqs: [7] }),
    ]);
  });

  it.each(['version', 'release_commit', 'source'] as const)(
    'refuses a record without %s',
    async (field) => {
      const store = storeWith(CURRENT);
      const { [field]: _omitted, ...rest } = release;

      await expect(refusalOf(store.run(rest))).resolves.toBe(
        'validation_failed'
      );
      expect(store.recorded).toEqual([]);
    }
  );
});
