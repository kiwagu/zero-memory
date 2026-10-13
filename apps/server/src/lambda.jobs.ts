import { InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';
import {
  entityIdSchemas,
  memoryIdSchema,
  userIdSchema,
} from '@workspace/contracts';
import { HygieneScanner, runOwnerScan } from '@workspace/hygiene';
import { createLogger, type BackgroundDispatcher } from '@workspace/logger';
import {
  workClaimKey,
  workClaimTokenSchema,
  type IWorkClaims,
  type WorkClaimToken,
} from '@workspace/mcp';
import { createRoiRunner } from '@workspace/roi';
import { z } from 'zod';

import { runHygieneScan } from './hygiene-scheduler.js';
import {
  runTranslationPass,
  translationWorkerFromEnv,
} from './translation-scheduler.js';
import { runUsageUpkeep } from './usage-scheduler.js';

const logger = createLogger('lambda-jobs');

/**
 * Work that runs on its own function on AWS Lambda, one invocation per run.
 * On a container host the scheduled jobs run on in-process timers and the
 * handed-off work runs in the background of the request that started it; on
 * Lambda a scheduler, or the server through `runInBackground`, invokes the
 * jobs function directly with one of these, and the same code does the work.
 */
const job = <Name extends string, Args extends z.ZodTypeAny>(
  name: Name,
  args: Args
) => z.object({ zeroMemory: z.literal('job'), job: z.literal(name), args });

// Every id a job carries is checked against its own kind, so a payload with
// a malformed or misplaced id is refused before any work starts.
const probeIdSchema = entityIdSchemas.roi_probe.schema;

const jobEventSchema = z.discriminatedUnion('job', [
  // Scheduled.
  job('usage-upkeep', z.unknown().optional()),
  job('translation', z.unknown().optional()),
  job('hygiene', z.unknown().optional()),
  // Handed off by the server.
  job('translate-one', z.object({ memoryId: memoryIdSchema })),
  job('hygiene-one', z.object({ memoryId: memoryIdSchema })),
  job(
    'hygiene-scan',
    z.object({
      ownerId: userIdSchema,
      limit: z.number().int().positive().nullable(),
      claimToken: workClaimTokenSchema,
    })
  ),
  job(
    'benchmark-probes',
    z.object({ ownerId: userIdSchema, claimToken: workClaimTokenSchema })
  ),
  job(
    'benchmark-run',
    z.object({
      ownerId: userIdSchema,
      claimToken: workClaimTokenSchema,
      recalled: z.array(
        z.object({
          probeId: probeIdSchema,
          surfacedIds: z.array(memoryIdSchema),
        })
      ),
    })
  ),
]);

export type JobEvent = z.infer<typeof jobEventSchema>;

/**
 * Whether an event was sent by a caller with AWS credentials (a scheduler,
 * the server, an operator) rather than through the function URL: anything
 * that came through the URL carries `requestContext`. A direct invocation
 * that is neither a warm-up nor a job this function runs must fail loudly —
 * handed-off work is invoked asynchronously, and a quiet answer to it would
 * drop the work with nothing to show for it.
 */
export const isDirectInvocation = (event: unknown): boolean =>
  typeof event === 'object' && event !== null && !('requestContext' in event);

/** The job a direct invocation asks for, or null. */
export const parseJobEvent = (event: unknown): JobEvent | null => {
  if (!isDirectInvocation(event)) {
    return null;
  }
  const parsed = jobEventSchema.safeParse(event);
  return parsed.success ? parsed.data : null;
};

/**
 * The claims a worker holds work under: besides releasing them, it confirms
 * a claim before it runs the work (see `DynamoDbWorkClaims.confirm`).
 */
export interface WorkerClaims extends IWorkClaims {
  confirm(key: string, token: WorkClaimToken): Promise<boolean>;
}

/**
 * Runs one job. A scan or benchmark that a request handed over comes with the
 * owner's claim the request took: the job runs only while that claim is still
 * its own — a newer request may have taken it after it expired in the queue —
 * and releases it when it ends, success or not.
 */
export const runJob = async (
  event: JobEvent,
  claims?: WorkerClaims
): Promise<void> => {
  switch (event.job) {
    case 'usage-upkeep':
      return runUsageUpkeep();
    case 'translation':
      return runTranslationPass();
    case 'hygiene':
      return runHygieneScan();
    case 'translate-one':
      await translationWorkerFromEnv().translateOne(event.args.memoryId);
      return;
    case 'hygiene-one':
      await new HygieneScanner().scanOne(event.args.memoryId);
      return;
    case 'hygiene-scan':
      return underClaim(
        claims,
        workClaimKey('hygiene-scan', event.args.ownerId),
        event.args.claimToken,
        () => runOwnerScan(event.args.ownerId, event.args.limit ?? undefined)
      );
    case 'benchmark-probes':
      return underClaim(
        claims,
        workClaimKey('benchmark', event.args.ownerId),
        event.args.claimToken,
        async () => {
          await createRoiRunner().ensureProbes(event.args.ownerId);
        }
      );
    case 'benchmark-run':
      return underClaim(
        claims,
        workClaimKey('benchmark', event.args.ownerId),
        event.args.claimToken,
        async () => {
          const runner = createRoiRunner();
          const cases = await runner.casesFromIds(
            event.args.ownerId,
            event.args.recalled
          );
          await runner.judgeAndRecord(event.args.ownerId, cases);
          await runner.ensureProbes(event.args.ownerId);
        }
      );
  }
};

const underClaim = async (
  claims: WorkerClaims | undefined,
  key: string,
  token: WorkClaimToken,
  work: () => Promise<void>
): Promise<void> => {
  if (claims && !(await claims.confirm(key, token))) {
    logger.info('claimed work superseded; skipped', { claim: key });
    return;
  }
  try {
    await work();
  } finally {
    await claims?.release(key, token);
  }
};

/**
 * Hands work the server starts in the background (`runInBackground`) to the
 * jobs function as an asynchronous invocation. A function behind the edge
 * freezes as soon as it answers, so work left running there stalls, and is
 * lost when the instance goes; the jobs function runs it to the end instead,
 * one run at a time, with Lambda queueing the rest. The task's kind is the
 * job's name.
 */
export const jobsFunctionDispatcher =
  (
    functionName: string,
    client: Pick<LambdaClient, 'send'>
  ): BackgroundDispatcher =>
  async (task) => {
    await client.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: new TextEncoder().encode(
          JSON.stringify({ zeroMemory: 'job', job: task.kind, args: task.args })
        ),
      })
    );
  };
