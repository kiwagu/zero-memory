import { runHygieneScan } from './hygiene-scheduler.js';
import { runTranslationPass } from './translation-scheduler.js';
import { runUsageUpkeep } from './usage-scheduler.js';

/**
 * The server's timed jobs, for a deployment without a long-running process.
 * On a container host each one runs on its own in-process timer; on AWS
 * Lambda a scheduler invokes a jobs function directly with the job's name,
 * and the same run function does the work.
 */
const JOBS = {
  'usage-upkeep': runUsageUpkeep,
  translation: runTranslationPass,
  hygiene: runHygieneScan,
} as const;

export type JobName = keyof typeof JOBS;

export const JOB_NAMES = Object.keys(JOBS) as JobName[];

export interface JobEvent {
  zeroMemory: 'job';
  job: JobName;
}

/**
 * A job invocation comes from a caller with AWS credentials (the scheduler,
 * an operator); anything that arrived through the function URL carries
 * `requestContext` and is never one.
 */
export const isJobEvent = (event: unknown): event is JobEvent => {
  if (
    typeof event !== 'object' ||
    event === null ||
    'requestContext' in event
  ) {
    return false;
  }
  const { zeroMemory, job } = event as Partial<Record<string, unknown>>;
  return (
    zeroMemory === 'job' &&
    typeof job === 'string' &&
    (JOB_NAMES as string[]).includes(job)
  );
};

export const runJob = (job: JobName): Promise<void> => JOBS[job]();
