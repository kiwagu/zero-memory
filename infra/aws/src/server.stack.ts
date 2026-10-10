import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_dynamodb as dynamodb,
  aws_ecr_assets as ecrAssets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
  aws_ssm as ssm,
  type StackProps,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import { viewerRequestFunction } from './edge.function.js';
import { ServerObservability } from './server.observability.js';

export interface ServerStackProps extends StackProps {
  /** Short name of this deployment; it is part of every resource name. */
  stage: string;
  /** Tag of the locally built server image the Lambda image builds on. */
  serverImage: string;
  /** That image's id, so a new server build makes a new Lambda image. */
  serverImageId: string;
  /**
   * Memory of the function in MB. Lambda gives CPU in proportion to it, and
   * the embedding model runs on that CPU. Default 3008: against 2048 it
   * halved the 90th percentile of a search (283 ms against 586 ms measured).
   */
  memorySize?: number;
  /**
   * The current version of the server's environment secret. Instances read
   * the secret only when they start, so the deploy script stamps its version
   * into the function: a changed secret changes the function, and the deploy
   * replaces the running instances.
   */
  envVersion?: string;
  /**
   * The public host name, with `certificateArn` an ACM certificate for it in
   * us-east-1 (CloudFront takes certificates from there only). Without them
   * the server answers on the distribution's own address.
   */
  domainName?: string;
  certificateArn?: string;
  /** Where alarm notifications go by email. */
  alarmEmail?: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Responses slower than this are cut by the edge (CloudFront's origin
 * response timeout; 60 s is its ceiling without a quota increase), so the
 * function is given the same limit rather than the 15 minutes Lambda allows.
 */
const RESPONSE_TIMEOUT = Duration.seconds(60);

/**
 * The MCP server on AWS Lambda behind CloudFront, using an existing Supabase
 * project for its database and auth:
 *
 * - the function runs the server's own Bun runtime (`runtime-api` target of
 *   `apps/server/lambda.Dockerfile`) with 3 GB, for the in-image embedding
 *   model and the CPU it runs on;
 * - MCP sessions live in DynamoDB, because consecutive requests of one
 *   session can land on different instances; so do the OAuth rate limiter's
 *   counts, which per-instance counters would multiply;
 * - one Secrets Manager secret holds the server's environment (Supabase keys,
 *   dashboard URL) as JSON, plus the value of the header the edge adds;
 * - the function URL takes no IAM auth: CloudFront's origin access control
 *   would replace the clients' bearer tokens with its own signature and asks
 *   every POST for a body hash, which MCP clients do not send. The function
 *   refuses any request without the edge's header instead;
 * - the public URL (the distribution's address, or the custom domain) is
 *   published in an SSM parameter the function reads at start: it cannot be
 *   set on the function, which exists before the distribution;
 * - the edge names the address it saw each request come from in its own
 *   header, so a client's X-Forwarded-For never reaches the rate limiter
 *   (see edge.function.ts);
 * - the dashboard's address comes from the parameter the web stack publishes,
 *   and this stack publishes the MCP URL the dashboard calls;
 * - alarms and a dashboard watch the function (see ServerObservability).
 */
export class ServerStack extends Stack {
  constructor(scope: Construct, id: string, props: ServerStackProps) {
    super(scope, id, props);
    const { stage } = props;
    if (Boolean(props.domainName) !== Boolean(props.certificateArn)) {
      throw new Error('domainName and certificateArn go together.');
    }

    const sessions = new dynamodb.TableV2(this, 'McpSessions', {
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
      globalSecondaryIndexes: [
        {
          // The server's per-user session cap queries this index by name.
          indexName: 'byOwner',
          partitionKey: {
            name: 'ownerUserEntityId',
            type: dynamodb.AttributeType.STRING,
          },
          sortKey: { name: 'lastSeenAt', type: dynamodb.AttributeType.NUMBER },
          projectionType: dynamodb.ProjectionType.KEYS_ONLY,
        },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const rateLimits = new dynamodb.TableV2(this, 'RateLimits', {
      partitionKey: { name: 'bucket', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const serverEnv = new secretsmanager.Secret(this, 'ServerEnv', {
      secretName: `zero-memory/${stage}/server-env`,
      description:
        'Environment of the zero-memory server as JSON; ZM_ORIGIN_VERIFY is the edge header value',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'ZM_ORIGIN_VERIFY',
        excludePunctuation: true,
        passwordLength: 48,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const publicUrlParameterName = `/zero-memory/${stage}/public-url`;
    // Published by the web stack; read at start when it exists.
    const webUrlParameterName = `/zero-memory/${stage}/web-url`;

    const logGroup = new logs.LogGroup(this, 'ServerLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const server = new lambda.DockerImageFunction(this, 'Server', {
      code: lambda.DockerImageCode.fromImageAsset(
        join(repoRoot, 'apps/server'),
        {
          file: 'lambda.Dockerfile',
          target: 'runtime-api',
          buildArgs: { SERVER_IMAGE: props.serverImage },
          extraHash: props.serverImageId,
          // The Lambda image builds FROM the server image; it needs no context.
          exclude: ['**', '!lambda.Dockerfile'],
          platform: ecrAssets.Platform.LINUX_AMD64,
        }
      ),
      architecture: lambda.Architecture.X86_64,
      memorySize: props.memorySize ?? 3008,
      timeout: RESPONSE_TIMEOUT,
      logGroup,
      environment: {
        ZM_MCP_SESSION_TABLE: sessions.tableName,
        ZM_RATE_LIMIT_TABLE: rateLimits.tableName,
        ZM_ENV_SECRET_ID: serverEnv.secretArn,
        ZM_PUBLIC_URL_PARAMETER: publicUrlParameterName,
        ZM_WEB_URL_PARAMETER: webUrlParameterName,
        ...(props.envVersion ? { ZM_ENV_VERSION: props.envVersion } : {}),
      },
    });
    sessions.grantReadWriteData(server);
    rateLimits.grantReadWriteData(server);
    serverEnv.grantRead(server);
    // Granted by name: a reference to the parameter itself would make the
    // function depend on the distribution, which depends on the function.
    server.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [publicUrlParameterName, webUrlParameterName].map((name) =>
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: name.slice(1),
          })
        ),
      })
    );

    const functionUrl = server.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.BUFFERED,
    });

    const viewerAddress = viewerRequestFunction(this, 'ViewerAddress');

    const edge = new cloudfront.Distribution(this, 'Edge', {
      comment: `zero-memory ${stage}`,
      defaultBehavior: {
        origin: new origins.FunctionUrlOrigin(functionUrl, {
          customHeaders: {
            'x-origin-verify': serverEnv
              .secretValueFromJson('ZM_ORIGIN_VERIFY')
              .unsafeUnwrap(),
          },
          readTimeout: RESPONSE_TIMEOUT,
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // Every viewer header (the bearer token included) but Host: a
        // function URL answers only to its own host name.
        originRequestPolicy:
          cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        functionAssociations: [
          {
            function: viewerAddress,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      ...(props.domainName && props.certificateArn
        ? {
            domainNames: [props.domainName],
            certificate: acm.Certificate.fromCertificateArn(
              this,
              'EdgeCertificate',
              props.certificateArn
            ),
          }
        : {}),
    });

    const publicUrl = `https://${props.domainName ?? edge.distributionDomainName}`;
    new ssm.StringParameter(this, 'PublicUrl', {
      parameterName: publicUrlParameterName,
      stringValue: publicUrl,
      description: 'Public URL (OAuth issuer) of the zero-memory server',
    });
    // What the dashboard calls the server at.
    new ssm.StringParameter(this, 'McpUrlParameter', {
      parameterName: `/zero-memory/${stage}/mcp-url`,
      stringValue: `${publicUrl}/mcp`,
      description: 'MCP endpoint of the zero-memory server',
    });

    const observability = new ServerObservability(this, 'Observability', {
      stage,
      server,
      logGroup,
      timeout: RESPONSE_TIMEOUT,
      alarmEmail: props.alarmEmail,
    });

    new CfnOutput(this, 'McpUrl', { value: `${publicUrl}/mcp` });
    new CfnOutput(this, 'PublicUrlOutput', {
      key: 'PublicUrl',
      value: publicUrl,
    });
    new CfnOutput(this, 'FunctionUrlOutput', {
      key: 'FunctionUrl',
      value: functionUrl.url,
    });
    new CfnOutput(this, 'FunctionName', { value: server.functionName });
    new CfnOutput(this, 'ServerEnvSecret', { value: serverEnv.secretName });
    new CfnOutput(this, 'SessionTable', { value: sessions.tableName });
    new CfnOutput(this, 'EdgeDomain', { value: edge.distributionDomainName });
    new CfnOutput(this, 'AlarmTopic', { value: observability.topic.topicArn });
  }
}
