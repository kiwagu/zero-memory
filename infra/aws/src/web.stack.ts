import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_ecr_assets as ecrAssets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
  aws_ses as ses,
  aws_ssm as ssm,
  type StackProps,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { viewerRequestFunction } from './edge.function.js';

const runtimeDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../runtime'
);

/** Next.js answers well inside this; the edge allows up to 60 s. */
const RESPONSE_TIMEOUT = Duration.seconds(30);

export interface WebAppProps {
  stage: string;
  /** Short name; part of the secret and parameter names. */
  name: string;
  /** The app's folder in the repository, e.g. `apps/web`. */
  appDir: string;
  /** Tag of the locally built image of the app, and that image's id. */
  appImage: string;
  appImageId: string;
  /** SSM parameters the app reads at start, as environment variable → name. */
  parameters?: Record<string, string>;
  /** Plain settings for the app, set on the function. */
  environment?: Record<string, string>;
  /**
   * The current version of the app's environment secret, which instances
   * read only when they start: stamped into the function, a changed secret
   * makes the deploy replace them.
   */
  envVersion?: string;
  /** The function that names the viewer's address and host at the edge. */
  edgeFunction: cloudfront.IFunction;
  /** A host name of its own, with an ACM certificate for it in us-east-1. */
  domainName?: string;
  certificateArn?: string;
}

/**
 * One Next.js app of this repository on Lambda behind CloudFront: the app's
 * own image with the Lambda Web Adapter and an entry that loads its
 * configuration and answers only the edge (`runtime/web-app.Dockerfile`).
 * Pages are never cached at the edge; `/_next/static/*`, whose file names
 * change with their content, is.
 *
 * The app's environment lives in a secret of its own, as JSON, next to the
 * edge header's value it generates. Its address is published in an SSM
 * parameter for the other stacks to read.
 */
export class WebApp extends Construct {
  readonly fn: lambda.DockerImageFunction;
  readonly url: string;
  readonly secret: secretsmanager.Secret;
  readonly urlParameterName: string;

  constructor(scope: Construct, id: string, props: WebAppProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const { stage, name } = props;
    if (Boolean(props.domainName) !== Boolean(props.certificateArn)) {
      throw new Error(`${name}: domainName and certificateArn go together.`);
    }

    this.secret = new secretsmanager.Secret(this, 'Env', {
      secretName: `zero-memory/${stage}/${name}-env`,
      description: `Environment of the zero-memory ${name} as JSON; ZM_ORIGIN_VERIFY is the edge header value`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'ZM_ORIGIN_VERIFY',
        excludePunctuation: true,
        passwordLength: 48,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const parameters = Object.entries(props.parameters ?? {});
    const fn = (this.fn = new lambda.DockerImageFunction(this, 'Function', {
      code: lambda.DockerImageCode.fromImageAsset(runtimeDir, {
        file: 'web-app.Dockerfile',
        buildArgs: { APP_IMAGE: props.appImage, APP_DIR: props.appDir },
        extraHash: props.appImageId,
        exclude: ['**', '!web-app.Dockerfile', '!web-app.entry.ts'],
        platform: ecrAssets.Platform.LINUX_AMD64,
      }),
      architecture: lambda.Architecture.X86_64,
      memorySize: 1024,
      timeout: RESPONSE_TIMEOUT,
      logGroup: new logs.LogGroup(this, 'Logs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        ...props.environment,
        ZM_ENV_SECRET_ID: this.secret.secretArn,
        ...(props.envVersion ? { ZM_ENV_VERSION: props.envVersion } : {}),
        ...(parameters.length > 0
          ? {
              ZM_PARAMETERS: parameters
                .map(([variable, parameter]) => `${variable}=${parameter}`)
                .join(','),
            }
          : {}),
      },
    }));
    this.secret.grantRead(fn);
    if (parameters.length > 0) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameters'],
          resources: parameters.map(([, parameter]) =>
            stack.formatArn({
              service: 'ssm',
              resource: 'parameter',
              resourceName: parameter.slice(1),
            })
          ),
        })
      );
    }

    const origin = new origins.FunctionUrlOrigin(
      fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE }),
      {
        customHeaders: {
          'x-origin-verify': this.secret
            .secretValueFromJson('ZM_ORIGIN_VERIFY')
            .unsafeUnwrap(),
        },
        readTimeout: RESPONSE_TIMEOUT,
      }
    );

    const distribution = new cloudfront.Distribution(this, 'Edge', {
      comment: `zero-memory ${stage} ${name}`,
      defaultBehavior: {
        origin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy:
          cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        functionAssociations: [
          {
            function: props.edgeFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        '/_next/static/*': {
          origin,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      ...(props.domainName && props.certificateArn
        ? {
            domainNames: [props.domainName],
            certificate: acm.Certificate.fromCertificateArn(
              this,
              'Certificate',
              props.certificateArn
            ),
          }
        : {}),
    });

    this.url = `https://${props.domainName ?? distribution.distributionDomainName}`;
    this.urlParameterName = `/zero-memory/${stage}/${name}-url`;
    new ssm.StringParameter(this, 'Url', {
      parameterName: this.urlParameterName,
      stringValue: this.url,
      description: `Public URL of the zero-memory ${name}`,
    });
    new CfnOutput(this, 'EdgeDomain', {
      value: distribution.distributionDomainName,
    });
  }
}

export interface WebStackProps extends StackProps {
  stage: string;
  webImage: string;
  webImageId: string;
  docsImage: string;
  docsImageId: string;
  webDomainName?: string;
  webCertificateArn?: string;
  docsDomainName?: string;
  docsCertificateArn?: string;
  /** Current versions of the dashboard's and the docs' environment secrets. */
  webEnvVersion?: string;
  docsEnvVersion?: string;
  /**
   * A domain to send authentication mail from through Amazon SES. The stack
   * creates its SES identity with Easy DKIM and prints the DNS records the
   * domain needs; the dashboard then sends Supabase Auth's mail through the
   * send-email hook, once the hook's secret is in its environment.
   */
  mailDomain?: string;
  /** The sender, e.g. `zero-memory <noreply@example.com>`; default noreply@<mailDomain>. */
  mailFrom?: string;
}

/**
 * The dashboard and the documentation site. The dashboard calls the server at
 * the MCP URL the server stack publishes, and publishes its own address
 * (`/zero-memory/<stage>/web-url`), which the server sends people to when
 * they sign in and approve an agent. Neither stack refers to the other at
 * deploy time, so either can be deployed alone; deploy this one first, so
 * the server finds the dashboard's address when it starts.
 */
export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { stage } = props;
    const edgeFunction = viewerRequestFunction(this, 'ViewerAddress');

    const dashboard = new WebApp(this, 'Dashboard', {
      stage,
      name: 'web',
      appDir: 'apps/web',
      appImage: props.webImage,
      appImageId: props.webImageId,
      parameters: { ZM_SERVER_URL: `/zero-memory/${stage}/mcp-url` },
      environment: props.mailDomain
        ? {
            ZM_MAIL_TRANSPORT: 'ses',
            ZM_MAIL_FROM:
              props.mailFrom ?? `zero-memory <noreply@${props.mailDomain}>`,
          }
        : undefined,
      envVersion: props.webEnvVersion,
      edgeFunction,
      domainName: props.webDomainName,
      certificateArn: props.webCertificateArn,
    });
    const docs = new WebApp(this, 'Docs', {
      stage,
      name: 'docs',
      appDir: 'apps/docs',
      appImage: props.docsImage,
      appImageId: props.docsImageId,
      envVersion: props.docsEnvVersion,
      edgeFunction,
      domainName: props.docsDomainName,
      certificateArn: props.docsCertificateArn,
    });

    if (props.mailDomain) {
      const identity = new ses.EmailIdentity(this, 'MailIdentity', {
        identity: ses.Identity.domain(props.mailDomain),
      });
      // SES checks a send against the sender's own address
      // (`identity/noreply@example.com`), not only against the domain's
      // identity, so a grant on the domain's ARN alone is refused. The
      // dashboard may send as any identity, but only from this domain.
      dashboard.fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ses:SendEmail', 'ses:SendRawEmail'],
          resources: [
            this.formatArn({
              service: 'ses',
              resource: 'identity',
              resourceName: '*',
            }),
          ],
          conditions: {
            StringLike: { 'ses:FromAddress': `*@${props.mailDomain}` },
          },
        })
      );
      identity.dkimRecords.forEach((record, index) => {
        new CfnOutput(this, `MailDkim${index + 1}`, {
          value: `${record.name} CNAME ${record.value}`,
        });
      });
      new CfnOutput(this, 'MailHookUrl', {
        value: `${dashboard.url}/auth/hooks/send-email`,
      });
    }

    new CfnOutput(this, 'DashboardUrl', { value: dashboard.url });
    new CfnOutput(this, 'DashboardSecret', {
      value: dashboard.secret.secretName,
    });
    new CfnOutput(this, 'DocsUrl', { value: docs.url });
  }
}
