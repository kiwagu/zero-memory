import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Size,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as actions,
  aws_ecr_assets as ecrAssets,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  aws_scheduler as scheduler,
  aws_scheduler_targets as targets,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export interface DatabaseBackupProps {
  stage: string;
  alarmTopic: sns.ITopic;
  /**
   * The current version of the backup's environment secret, stamped into the
   * function so a changed secret replaces its instances (see deploy.sh).
   */
  envVersion?: string;
}

/**
 * A daily logical backup of the database into S3. The function runs the
 * container host's own dump script (`infra/prod/scripts/db-dump.sh`)
 * unchanged, so the artifact, its checks and its manifest are the ones the
 * restore script expects (see runtime/backup.entry.ts).
 *
 * - The database URL lives in the secret `zero-memory/<stage>/backup-env` as
 *   DATABASE_URL. The function runs outside a VPC with IPv4 only, so for a
 *   Supabase project it must be the session pooler's address.
 * - Artifacts land under `daily/`, and every object in the bucket expires 30
 *   days after it is written. The bucket is versioned, so the function, which
 *   may write but not delete, cannot destroy a backup by writing over it
 *   either: the bytes it replaced stay one more day.
 * - The bucket is retained when the stack is removed: the backups are the one
 *   thing a teardown must not take with it.
 * - One alarm fires on a failed run, another when no backup has landed for
 *   more than a day.
 */
export class DatabaseBackup extends Construct {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DatabaseBackupProps) {
    super(scope, id);
    const { stage } = props;

    // Versioned: the function may write but never delete, and a write over an
    // existing key would otherwise replace a backup as surely as a delete.
    // Artifact names carry the time they were taken, so no backup writes over
    // another, and a version turns noncurrent only when it expires. It goes a
    // day later: a backup, and the data it holds, is gone about 30 days after
    // it was taken. The rule spans the whole bucket, so it also expires the
    // monthly copies earlier releases kept under `monthly/`.
    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        {
          id: 'backups',
          expiration: Duration.days(30),
          noncurrentVersionExpiration: Duration.days(1),
        },
        // An expired backup leaves a delete marker over its old versions;
        // once those are gone too, the marker goes.
        { id: 'markers', expiredObjectDeleteMarker: true },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const env = new secretsmanager.Secret(this, 'Env', {
      secretName: `zero-memory/${stage}/backup-env`,
      description:
        'Environment of the zero-memory database backup as JSON: DATABASE_URL, an IPv4 Postgres URL such as the Supabase session pooler',
      secretObjectValue: {},
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const fn = new lambda.DockerImageFunction(this, 'Function', {
      code: lambda.DockerImageCode.fromImageAsset(repoRoot, {
        file: 'infra/aws/runtime/backup.Dockerfile',
        // Only what the image copies; the repository's .dockerignore lets
        // these two through its `infra` exclusion as well.
        exclude: [
          '**',
          '!infra/aws/runtime/backup.Dockerfile',
          '!infra/aws/runtime/backup.entry.ts',
          '!infra/prod/scripts/db-dump.sh',
        ],
        platform: ecrAssets.Platform.LINUX_AMD64,
      }),
      architecture: lambda.Architecture.X86_64,
      memorySize: 1024,
      timeout: Duration.minutes(15),
      // The dump is assembled and checked on local disk before it is stored.
      ephemeralStorageSize: Size.gibibytes(2),
      reservedConcurrentExecutions: 1,
      retryAttempts: 0,
      logGroup,
      environment: {
        ZM_ENV_SECRET_ID: env.secretArn,
        ZM_BACKUP_BUCKET: this.bucket.bucketName,
        ...(props.envVersion ? { ZM_ENV_VERSION: props.envVersion } : {}),
      },
    });
    env.grantRead(fn);
    // Read, list and write, never delete: whatever takes over the function
    // cannot remove the backups it would want gone; only the lifecycle
    // rules expire them.
    this.bucket.grantRead(fn);
    this.bucket.grantPut(fn);

    new scheduler.Schedule(this, 'Daily', {
      description: `Backs up the zero-memory ${stage} database`,
      schedule: scheduler.ScheduleExpression.cron({ hour: '3', minute: '30' }),
      target: new targets.LambdaInvoke(fn, { retryAttempts: 0 }),
    });

    const notify = new actions.SnsAction(props.alarmTopic);
    new cloudwatch.Alarm(this, 'Failed', {
      metric: fn.metricErrors({ period: Duration.hours(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'A database backup failed.',
    }).addAlarmAction(notify);

    // The dead-man switch: a run that never happened logs nothing and fails
    // nothing, so only the absence of stored backups can reveal it. Hourly
    // points over 26 hours span one daily run with room for its duration.
    const stored = new logs.MetricFilter(this, 'StoredFilter', {
      logGroup,
      filterPattern: logs.FilterPattern.stringValue(
        '$.msg',
        '=',
        'backup stored'
      ),
      metricNamespace: `zero-memory/${stage}`,
      metricName: 'BackupsStored',
      metricValue: '1',
    }).metric({ statistic: 'Sum', period: Duration.hours(1) });
    new cloudwatch.Alarm(this, 'Missing', {
      metric: stored,
      threshold: 1,
      evaluationPeriods: 26,
      datapointsToAlarm: 26,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: 'No database backup has been stored for over a day.',
    }).addAlarmAction(notify);

    // Named outright: inside a construct an output's name would otherwise
    // carry a hash of its path.
    new CfnOutput(this, 'BucketName', {
      key: 'BackupBucket',
      value: this.bucket.bucketName,
    });
    new CfnOutput(this, 'EnvSecret', {
      key: 'BackupEnvSecret',
      value: env.secretName,
    });
    new CfnOutput(this, 'FunctionName', {
      key: 'BackupFunctionName',
      value: fn.functionName,
    });
  }
}
