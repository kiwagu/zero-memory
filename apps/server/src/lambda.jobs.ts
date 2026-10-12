import { InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';
import { HygieneScanner, runOwnerScan } from '@workspace/hygiene';
import type { BackgroundDispatcher } from '@workspace/logger';
import { createRoiRunner } from '@workspace/roi';
import { z } from 'zod';

import { runHygieneScan } from './hygiene-scheduler.js';
import {
  runTranslationPass,
  translationWorkerFromEnv,
} from './translation-scheduler.js';
import { runUsageUpkeep } from './usage-scheduler.js';

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

const id = z.string().min(1);

const jobEventSchema = z.discriminatedUnion('job', [
  // Scheduled.
  job('usage-upkeep', z.unknown().optional()),
  job('translation', z.unknown().optional()),
  job('hygiene', z.unknown().optional()),
  // Handed off by the server.
  job('translate-one', z.object({ memoryId: id })),
  job('hygiene-one', z.object({ memoryId: id })),
  job(
    'hygiene-scan',
    z.object({ ownerId: id, limit: z.number().int().positive().nullable() })
  ),
  job('benchmark-probes', z.object({ ownerId: id })),
  job(
    'benchmark-run',
    z.object({
      ownerId: id,
      recalled: z.array(z.object({ probeId: id, surfacedIds: z.array(id) })),
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

export const runJob = async (event: JobEvent): Promise<void> => {
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
      return runOwnerScan(event.args.ownerId, event.args.limit ?? undefined);
    case 'benchmark-probes':
      await createRoiRunner().ensureProbes(event.args.ownerId);
      return;
    case 'benchmark-run': {
      const runner = createRoiRunner();
      const cases = await runner.casesFromIds(
        event.args.ownerId,
        event.args.recalled
      );
      await runner.judgeAndRecord(event.args.ownerId, cases);
      await runner.ensureProbes(event.args.ownerId);
      return;
    }
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
