import {
  Duration,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as actions,
  aws_lambda as lambda,
  aws_scheduler as scheduler,
  aws_scheduler_targets as targets,
  aws_sns as sns,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

/** The server's timed jobs, by the name the jobs function takes. */
export type JobName = 'usage-upkeep' | 'translation' | 'hygiene';

export interface ServerJobsProps {
  /** The function behind the edge; the keep-warm schedule invokes it. */
  server: lambda.IFunction;
  /** The function that runs one job per invocation, one at a time. */
  jobs: lambda.Function;
  /**
   * Hours between runs of each job. A job without an interval is not
   * scheduled, as on the container host, where translation and hygiene stay
   * off until an operator sets theirs: both spend money on model calls.
   */
  intervals: Partial<Record<JobName, number>>;
  /** Minutes between keep-warm invocations; 0 turns them off. */
  keepWarmMinutes: number;
  alarmTopic: sns.ITopic;
}

/**
 * What the container host does with in-process timers, on a platform without
 * a long-running process: EventBridge Scheduler invokes the jobs function
 * with a job's name at that job's interval. A failed run is not retried; the
 * next one comes at the next interval, as on the host, and an alarm says it
 * failed.
 *
 * It also keeps one server instance warm. A new instance loads the embedding
 * model on its first search (seconds); invoking the server's warm-up every
 * few minutes keeps an instance that already has it, so a person's first
 * search after a pause does not wait.
 */
export class ServerJobs extends Construct {
  constructor(scope: Construct, id: string, props: ServerJobsProps) {
    super(scope, id);

    for (const [job, hours] of Object.entries(props.intervals)) {
      if (!hours) {
        continue;
      }
      new scheduler.Schedule(this, `Job-${job}`, {
        description: `Runs the zero-memory ${job} job`,
        schedule: scheduler.ScheduleExpression.rate(Duration.hours(hours)),
        target: new targets.LambdaInvoke(props.jobs, {
          input: scheduler.ScheduleTargetInput.fromObject({
            zeroMemory: 'job',
            job,
          }),
          retryAttempts: 0,
        }),
      });
    }

    if (props.keepWarmMinutes > 0) {
      new scheduler.Schedule(this, 'KeepWarm', {
        description:
          'Keeps one zero-memory server instance with its model loaded',
        schedule: scheduler.ScheduleExpression.rate(
          Duration.minutes(props.keepWarmMinutes)
        ),
        target: new targets.LambdaInvoke(props.server, {
          input: scheduler.ScheduleTargetInput.fromObject({
            zeroMemory: 'warm-up',
          }),
          retryAttempts: 0,
          // A warm-up that waited is no longer worth running.
          maxEventAge: Duration.minutes(1),
        }),
      });
    }

    new cloudwatch.Alarm(this, 'JobErrors', {
      metric: props.jobs.metricErrors({ period: Duration.hours(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'A timed job (usage upkeep, translation, hygiene) failed.',
    }).addAlarmAction(new actions.SnsAction(props.alarmTopic));
  }
}
