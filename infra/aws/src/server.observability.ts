import {
  Duration,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as actions,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_sns as sns,
  aws_sns_subscriptions as subscriptions,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface ServerObservabilityProps {
  stage: string;
  server: lambda.Function;
  logGroup: logs.ILogGroup;
  /** The function's timeout; an invocation close to it is about to be cut. */
  timeout: Duration;
  /** Where alarm notifications go by email; without it, only the topic. */
  alarmEmail?: string;
}

const PERIOD = Duration.minutes(5);

/**
 * Alarms and a dashboard for the server function, all in the function's own
 * Region: Lambda's metrics plus two metrics read out of its log, which
 * already records every failed start and every request with its status.
 * Alarms go to one SNS topic.
 *
 * Nothing here watches CloudFront, whose metrics live in us-east-1: a broken
 * edge shows up as silence on the function, not as an alarm.
 */
export class ServerObservability extends Construct {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: ServerObservabilityProps) {
    super(scope, id);
    const { server, logGroup, stage } = props;
    const namespace = `zero-memory/${stage}`;

    this.topic = new sns.Topic(this, 'Alarms', {
      displayName: `zero-memory ${stage} alarms`,
    });
    if (props.alarmEmail) {
      this.topic.addSubscription(
        new subscriptions.EmailSubscription(props.alarmEmail)
      );
    }

    // Lambda writes "Runtime.InitError" on the platform lines of every start
    // that failed, whether or not the runtime got far enough to log a reason.
    const failedStarts = new logs.MetricFilter(this, 'FailedStartsFilter', {
      logGroup,
      filterPattern: logs.FilterPattern.literal('"Runtime.InitError"'),
      metricNamespace: namespace,
      metricName: 'FailedStarts',
      metricValue: '1',
    }).metric({ statistic: 'Sum', period: PERIOD });

    const serverErrors = new logs.MetricFilter(this, 'ServerErrorsFilter', {
      logGroup,
      filterPattern: logs.FilterPattern.all(
        logs.FilterPattern.stringValue('$.msg', '=', 'http request'),
        logs.FilterPattern.numberValue('$.status', '>=', 500)
      ),
      metricNamespace: namespace,
      metricName: 'ServerErrors',
      metricValue: '1',
    }).metric({ statistic: 'Sum', period: PERIOD });

    const alarm = (
      name: string,
      metric: cloudwatch.IMetric,
      threshold: number,
      description: string
    ) => {
      const created = new cloudwatch.Alarm(this, name, {
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      });
      created.addAlarmAction(new actions.SnsAction(this.topic));
      return created;
    };

    alarm(
      'InvocationErrors',
      server.metricErrors({ period: PERIOD }),
      1,
      'An invocation failed or timed out.'
    );
    alarm(
      'Throttles',
      server.metricThrottles({ period: PERIOD }),
      1,
      'Requests were refused for lack of concurrency.'
    );
    alarm(
      'NearTimeout',
      server.metricDuration({ period: PERIOD, statistic: 'Maximum' }),
      props.timeout.toMilliseconds() * 0.9,
      'An invocation ran close to the timeout the edge also enforces.'
    );
    alarm(
      'FailedStarts',
      failedStarts,
      1,
      'An instance failed to start; the log names the reason.'
    );
    alarm(
      'ServerErrors',
      serverErrors,
      3,
      'The server answered 5xx three or more times in five minutes.'
    );

    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `zero-memory-${stage}`,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'Invocations and errors',
            left: [
              server.metricInvocations({ period: PERIOD }),
              server.metricErrors({ period: PERIOD }),
              server.metricThrottles({ period: PERIOD }),
            ],
            width: 12,
          }),
          new cloudwatch.GraphWidget({
            title: 'Duration (ms)',
            left: ['p50', 'p95', 'Maximum'].map((statistic) =>
              server.metricDuration({ period: PERIOD, statistic })
            ),
            width: 12,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: '5xx answers and failed starts',
            left: [serverErrors, failedStarts],
            width: 12,
          }),
          new cloudwatch.GraphWidget({
            title: 'Concurrent instances',
            left: [
              server.metric('ConcurrentExecutions', {
                period: PERIOD,
                statistic: 'Maximum',
              }),
            ],
            width: 12,
          }),
        ],
      ],
    });
  }
}
