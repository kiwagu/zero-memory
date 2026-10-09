import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
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

export interface ServerStackProps extends StackProps {
  /** Short name of this deployment; it is part of every resource name. */
  stage: string;
  /** Tag of the locally built server image the Lambda image builds on. */
  serverImage: string;
  /** That image's id, so a new server build makes a new Lambda image. */
  serverImageId: string;
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
 *   `apps/server/lambda.Dockerfile`) with 2 GB, which the in-image embedding
 *   model needs;
 * - MCP sessions live in DynamoDB, because consecutive requests of one
 *   session can land on different instances;
 * - one Secrets Manager secret holds the server's environment (Supabase keys,
 *   dashboard URL) as JSON, plus the value of the header the edge adds;
 * - the function URL takes no IAM auth: CloudFront's origin access control
 *   would replace the clients' bearer tokens with its own signature and asks
 *   every POST for a body hash, which MCP clients do not send. The function
 *   refuses any request without the edge's header instead;
 * - the public URL is the distribution's address, published in an SSM
 *   parameter the function reads at start (it cannot be set on the function,
 *   which exists before the distribution).
 */
export class ServerStack extends Stack {
  constructor(scope: Construct, id: string, props: ServerStackProps) {
    super(scope, id, props);
    const { stage } = props;

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
      memorySize: 2048,
      timeout: RESPONSE_TIMEOUT,
      logGroup: new logs.LogGroup(this, 'ServerLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        ZM_MCP_SESSION_TABLE: sessions.tableName,
        ZM_ENV_SECRET_ID: serverEnv.secretArn,
        ZM_PUBLIC_URL_PARAMETER: publicUrlParameterName,
      },
    });
    sessions.grantReadWriteData(server);
    serverEnv.grantRead(server);
    // Granted by name: a reference to the parameter itself would make the
    // function depend on the distribution, which depends on the function.
    server.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: publicUrlParameterName.slice(1),
          }),
        ],
      })
    );

    const functionUrl = server.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.BUFFERED,
    });

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
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });

    const publicUrl = `https://${edge.distributionDomainName}`;
    new ssm.StringParameter(this, 'PublicUrl', {
      parameterName: publicUrlParameterName,
      stringValue: publicUrl,
      description: 'Public URL (OAuth issuer) of the zero-memory server',
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
    new CfnOutput(this, 'ServerEnvSecret', { value: serverEnv.secretName });
    new CfnOutput(this, 'SessionTable', { value: sessions.tableName });
  }
}
