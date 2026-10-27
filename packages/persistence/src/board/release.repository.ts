import {
  toCardFailure,
  type CardFailure,
  type ConfigureReleaseParams,
  type IReleaseRepository,
  type RecordedRelease,
  type RecordReleaseParams,
} from '@workspace/board';
import { injectContext, type IContext } from '@workspace/context';
import {
  observedReleaseSchema,
  releaseCandidateSchema,
  releaseSettingsSchema,
  type ReleaseCandidate,
  type ReleaseSettings,
} from '@workspace/contracts';
import { singleton } from '@workspace/di';
import type { Database } from '@workspace/db';
import { Err, Ok, type Result } from 'oxide.ts';
import { z } from 'zod';

import { createUserClient, type Client } from '../supabase.client.js';

/** The store commands a release call maps to, one method each. */
type ReleaseFn =
  | 'release_settings'
  | 'release_configure'
  | 'release_candidates'
  | 'release_record';

type ReleaseFnArgs<T extends ReleaseFn> =
  Database['public']['Functions'][T]['Args'];

/** Every release command answers a failure code or its payload, never raises. */
const answerSchema = z.object({
  error: z.string().optional(),
  message: z.string().nullish(),
  settings: releaseSettingsSchema.nullable().optional(),
  cards: z.array(releaseCandidateSchema).optional(),
  release: observedReleaseSchema.optional(),
  recorded: z.array(z.string()).optional(),
  moved: z.array(z.string()).optional(),
});
type Answer = z.infer<typeof answerSchema>;

/**
 * Supabase adapter for the release store commands.
 *
 * Runs as the CALLER (never service role), same as `SupabaseCardRepository`:
 * the store's own policies decide `forbidden` vs `not_found`, this layer only
 * turns `{error, message}` into a `CardFailure`.
 */
@singleton()
export class SupabaseReleaseRepository implements IReleaseRepository {
  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async settings(
    scope: string
  ): Promise<Result<ReleaseSettings | null, CardFailure>> {
    const answer = await this.#call('release_settings', { p_scope: scope });
    return answer.isErr()
      ? Err(answer.unwrapErr())
      : Ok(answer.unwrap().settings ?? null);
  }

  async configure(
    params: ConfigureReleaseParams
  ): Promise<Result<ReleaseSettings | null, CardFailure>> {
    const answer = await this.#call('release_configure', {
      p_scope: params.scope,
      p_version_url: params.versionUrl ?? undefined,
      p_version_field: params.versionField ?? undefined,
      p_tag_template: params.tagTemplate ?? undefined,
      p_tag_pattern: params.tagPattern ?? undefined,
      p_on_release: params.onRelease ?? undefined,
    });
    return answer.isErr()
      ? Err(answer.unwrapErr())
      : Ok(answer.unwrap().settings ?? null);
  }

  async candidates(
    scope: string,
    version: string
  ): Promise<Result<ReleaseCandidate[], CardFailure>> {
    const answer = await this.#call('release_candidates', {
      p_scope: scope,
      p_version: version,
    });
    return answer.isErr()
      ? Err(answer.unwrapErr())
      : Ok(answer.unwrap().cards ?? []);
  }

  async record(
    params: RecordReleaseParams
  ): Promise<Result<RecordedRelease, CardFailure>> {
    // `p_build` has no SQL default (unlike the other optional fields, which
    // fall back to their own defaults when omitted): it must always be sent,
    // even as null, or the store rejects the call outright as a missing
    // argument. The generated Args type does not carry that nullability, so
    // the object is built with the port's own (correct) type and asserted
    // onto the generated one at the call site.
    const args: { p_build: string | null } & Omit<
      ReleaseFnArgs<'release_record'>,
      'p_build'
    > = {
      p_scope: params.scope,
      p_version: params.version,
      p_build: params.build,
      p_release_commit: params.releaseCommit,
      p_source: params.source,
      p_card_ids: params.cardIds,
      p_landing_seqs: params.landingSeqs,
      p_thread: params.thread ?? undefined,
      p_agent_label: params.agentLabel ?? undefined,
    };
    const answer = await this.#call(
      'release_record',
      args as ReleaseFnArgs<'release_record'>
    );
    if (answer.isErr()) return Err(answer.unwrapErr());
    const { release, recorded = [], moved = [] } = answer.unwrap();
    if (!release)
      return Err(
        toCardFailure('invalid', 'release_record answered no release.')
      );
    return Ok({ release, recorded, moved });
  }

  async #call<T extends ReleaseFn>(
    fn: T,
    args: ReleaseFnArgs<T>
  ): Promise<Result<Answer, CardFailure>> {
    const { data, error } = await this.#client().rpc(fn, args);
    if (error) {
      throw new Error(`${fn} failed: ${error.message}`);
    }
    const parsed = answerSchema.parse(data ?? {});
    return parsed.error
      ? Err(toCardFailure(parsed.error, parsed.message))
      : Ok(parsed);
  }

  #client(): Client {
    const accessToken = this.context.getAccessToken();
    if (!accessToken) {
      throw new Error('No access token in the execution context.');
    }
    return createUserClient(accessToken);
  }
}
