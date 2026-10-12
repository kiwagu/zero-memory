import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { ServerStack, type ServerStackProps } from './server.stack.js';

const synth = (overrides: Partial<ServerStackProps> = {}): Template =>
  Template.fromStack(
    new ServerStack(new App(), 'zero-memory-test', {
      stage: 'test',
      serverImage: 'zero-memory-server:test',
      serverImageId: 'sha256:test',
      env: { account: '111111111111', region: 'eu-north-1' },
      ...overrides,
    })
  );

describe('ServerStack', () => {
  it('runs the server with both tables, behind an edge that adds its header', () => {
    const template = synth();
    template.resourceCountIs('AWS::DynamoDB::GlobalTable', 2);
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 3008,
      Timeout: 60,
      Environment: {
        Variables: Match.objectLike({
          ZM_MCP_SESSION_TABLE: Match.anyValue(),
          ZM_RATE_LIMIT_TABLE: Match.anyValue(),
          ZM_ENV_SECRET_ID: Match.anyValue(),
          ZM_PUBLIC_URL_PARAMETER: '/zero-memory/test/public-url',
        }),
      },
    });
    template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE' });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: Match.absent(),
        Origins: [
          Match.objectLike({
            OriginCustomHeaders: [
              Match.objectLike({ HeaderName: 'x-origin-verify' }),
            ],
          }),
        ],
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'https-only',
        }),
      }),
    });
  });

  it('serves a custom domain with its certificate when given both', () => {
    const certificateArn =
      'arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000';
    const template = synth({ domainName: 'api.example.com', certificateArn });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['api.example.com'],
        ViewerCertificate: Match.objectLike({
          AcmCertificateArn: certificateArn,
        }),
      }),
    });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Value: 'https://api.example.com',
    });
  });

  it('refuses a domain without a certificate', () => {
    expect(() => synth({ domainName: 'api.example.com' })).toThrow(
      'domainName and certificateArn go together.'
    );
  });

  it('alarms into one topic, and mails it only when asked to', () => {
    const silent = synth();
    // Five on the server, one on the jobs, two on the backups.
    silent.resourceCountIs('AWS::CloudWatch::Alarm', 8);
    silent.allResourcesProperties('AWS::CloudWatch::Alarm', {
      AlarmActions: [
        Match.objectLike({ Ref: Match.stringLikeRegexp('Alarms') }),
      ],
    });
    silent.resourceCountIs('AWS::SNS::Subscription', 0);
    silent.resourceCountIs('AWS::CloudWatch::Dashboard', 1);

    synth({ alarmEmail: 'ops@example.com' }).hasResourceProperties(
      'AWS::SNS::Subscription',
      { Protocol: 'email', Endpoint: 'ops@example.com' }
    );
  });

  it('carries the version of its environment secret, so a changed secret replaces its instances', () => {
    synth({ envVersion: 'v-2' }).hasResourceProperties(
      'AWS::Lambda::Function',
      {
        Environment: {
          Variables: Match.objectLike({ ZM_ENV_VERSION: 'v-2' }),
        },
      }
    );
    synth().hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ ZM_ENV_VERSION: Match.absent() }),
      },
    });
  });

  it('gives the edge the same version of the shared value the function reads', () => {
    const distribution = JSON.stringify(
      synth({ envVersion: 'v-2' }).findResources(
        'AWS::CloudFront::Distribution'
      )
    );
    expect(distribution).toContain(':SecretString:ZM_ORIGIN_VERIFY::v-2}}');
  });

  it('takes the memory size it is given', () => {
    synth({ memorySize: 2048 }).hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 2048,
    });
  });

  it('runs the timed jobs on a function of their own, one run at a time, outside the edge', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 900,
      ReservedConcurrentExecutions: 1,
      Environment: {
        Variables: Match.objectLike({ ZM_ENV_SECRET_ID: Match.anyValue() }),
      },
    });
    // Only the server answers HTTP.
    template.resourceCountIs('AWS::Lambda::Url', 1);
  });

  it('lets the server hand its background work to the jobs function', () => {
    const template = synth();
    // Only the function behind the edge names the jobs function; the jobs
    // function runs such work in place.
    const named = Object.values(
      template.findResources('AWS::Lambda::Function')
    ).filter((fn) => JSON.stringify(fn).includes('ZM_JOBS_FUNCTION'));
    expect(named).toHaveLength(1);
    expect(JSON.stringify(named[0])).not.toContain('"Timeout":900');
    const invokes = Object.values(
      template.findResources('AWS::IAM::Policy')
    ).filter((policy) =>
      JSON.stringify(policy).includes('lambda:InvokeFunction')
    );
    expect(JSON.stringify(invokes)).toMatch(/ServerServiceRole/);
    // The jobs function releases the owner's claim on the work it ran; the
    // claims live in the rate-limit table.
    const jobsPolicy = JSON.stringify(
      template.findResources('AWS::IAM::Policy', {
        Properties: {
          Roles: [{ Ref: Match.stringLikeRegexp('^JobsServiceRole') }],
        },
      })
    );
    expect(jobsPolicy).toContain('dynamodb:DeleteItem');
    expect(jobsPolicy).toMatch(/RateLimits/);
  });

  it('schedules usage upkeep always, the paid jobs only when given an interval', () => {
    const jobSchedules = (template: Template): string[] =>
      Object.values(template.findResources('AWS::Scheduler::Schedule'))
        .map(
          (schedule) =>
            (
              schedule as {
                Properties: {
                  ScheduleExpression: string;
                  Target: { Input?: string };
                };
              }
            ).Properties
        )
        .filter(({ Target }) => Target.Input?.includes('"job"'))
        .map(
          ({ ScheduleExpression, Target }) =>
            `${(JSON.parse(Target.Input ?? '{}') as { job: string }).job} ${ScheduleExpression}`
        )
        .sort();

    expect(jobSchedules(synth())).toEqual(['usage-upkeep rate(1 day)']);
    // An unset interval (a stage without the setting) keeps the default.
    expect(
      jobSchedules(synth({ jobIntervals: { 'usage-upkeep': undefined } }))
    ).toEqual(['usage-upkeep rate(1 day)']);
    expect(
      jobSchedules(
        synth({
          jobIntervals: { 'usage-upkeep': 12, translation: 24, hygiene: 48 },
        })
      )
    ).toEqual([
      'hygiene rate(2 days)',
      'translation rate(1 day)',
      'usage-upkeep rate(12 hours)',
    ]);
  });

  it('keeps one server instance warm unless told not to', () => {
    synth().hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'rate(5 minutes)',
      Target: Match.objectLike({ Input: '{"zeroMemory":"warm-up"}' }),
    });
    const cold = Object.values(
      synth({ keepWarmMinutes: 0 }).findResources('AWS::Scheduler::Schedule')
    ).filter((schedule) => JSON.stringify(schedule).includes('warm-up'));
    expect(cold).toHaveLength(0);
  });

  it('backs the database up daily into a bucket that outlives the stack, and alarms when backups stop', () => {
    const template = synth();
    // Versioned, so a write over an existing backup keeps the old bytes for as
    // long as the backup itself would have lived.
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        VersioningConfiguration: { Status: 'Enabled' },
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Prefix: 'daily/',
              ExpirationInDays: 30,
              NoncurrentVersionExpiration: { NoncurrentDays: 30 },
            }),
            Match.objectLike({
              Prefix: 'monthly/',
              ExpirationInDays: 366,
              NoncurrentVersionExpiration: { NoncurrentDays: 30 },
            }),
          ]),
        },
      }),
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'zero-memory/test/backup-env',
    });
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(30 3 * * ? *)',
    });
    // No backup for longer than a day and a bit: every hourly point empty.
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      ComparisonOperator: 'LessThanThreshold',
      Threshold: 1,
      Period: 3600,
      EvaluationPeriods: 26,
      DatapointsToAlarm: 26,
      TreatMissingData: 'breaching',
    });

    // The function that writes the backups cannot delete them.
    const policies = JSON.stringify(
      template.findResources('AWS::IAM::Policy', {
        Properties: {
          Roles: [{ Ref: Match.stringLikeRegexp('BackupFunctionServiceRole') }],
        },
      })
    );
    expect(policies).toContain('s3:PutObject');
    expect(policies).not.toContain('s3:DeleteObject');
    expect(policies).not.toMatch(/s3:PutBucket|s3:PutLifecycle|s3:\*/);

    const without = synth({ backups: false });
    without.resourceCountIs('AWS::S3::Bucket', 0);
  });

  it("overwrites the viewer's address header at the edge, on every request", () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionCode: Match.stringLikeRegexp(
        "headers\\['x-viewer-address'\\] = \\{ value: event\\.viewer\\.ip \\}"
      ),
    });
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionCode: Match.stringLikeRegexp("headers\\['x-forwarded-host'\\]"),
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          FunctionAssociations: [
            Match.objectLike({ EventType: 'viewer-request' }),
          ],
        }),
      }),
    });
  });
});
