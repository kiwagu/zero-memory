import {
  ArnFormat,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  aws_codebuild as codebuild,
  aws_codepipeline as codepipeline,
  aws_codepipeline_actions as actions,
  aws_codestarconnections as connections,
  aws_iam as iam,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  type StackProps,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export interface PipelineStackProps extends StackProps {
  /** The stage this pipeline deploys: the stack `zero-memory-<stage>`. */
  stage: string;
  /** The GitHub repository releases are tagged in, as `owner/name`. */
  repository: string;
  /** The branch the source follows; the pipeline needs one besides tags. */
  branch: string;
  /** Tags that start a deploy (glob patterns). */
  tagPatterns: string[];
  /**
   * A Secrets Manager secret with `username` and `token` for Docker Hub,
   * when its anonymous pull limit gets in the way of the build.
   */
  dockerHubSecretName?: string;
  /**
   * The stage's settings (`stages/<stage>.json`), handed to every build so a
   * pipeline deploy uses the same ones a deploy by hand does.
   */
  deploySettings?: Record<string, string>;
}

/**
 * Deploys the server from a release tag, inside the AWS account: CodePipeline
 * takes the tagged commit from GitHub through a CodeConnections connection,
 * and CodeBuild applies the database migrations and runs the same deploy
 * script an operator runs by hand (`infra/aws/buildspec.yml`).
 *
 * No AWS key leaves AWS: the build's role may only assume the CDK bootstrap
 * roles, invoke the deployed function for its warm-up, read its own secrets,
 * and see which version each app's environment secret is at.
 *
 * Two values are set by hand once: the connection is created pending and
 * becomes usable when it is approved in the console (which installs the AWS
 * Connector app on the GitHub repository), and the database URL secret is
 * created empty for the operator to fill.
 */
export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);
    const { stage } = props;
    const [owner, repo] = props.repository.split('/');
    if (!owner || !repo) {
      throw new Error('repository must be owner/name.');
    }

    const connection = new connections.CfnConnection(this, 'GitHub', {
      connectionName: `zero-memory-${stage}`.slice(0, 32),
      providerType: 'GitHub',
    });

    // CodeBuild reads its secret variables by name, and builds their read
    // permission from the name as written: a token there renders unusable.
    const databaseUrlName = `zero-memory/${stage}/database-url`;
    const databaseUrl = new secretsmanager.Secret(this, 'DatabaseUrl', {
      secretName: databaseUrlName,
      description:
        'Postgres URL the deploy applies migrations through; an IPv4 one, such as the Supabase session pooler',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const dockerHub = props.dockerHubSecretName
      ? secretsmanager.Secret.fromSecretNameV2(
          this,
          'DockerHub',
          props.dockerHubSecretName
        )
      : undefined;

    const project = new codebuild.PipelineProject(this, 'Deploy', {
      description: `Deploys zero-memory-${stage} from a release`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename(
        'infra/aws/buildspec.yml'
      ),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.MEDIUM,
        // The build runs Docker.
        privileged: true,
      },
      environmentVariables: {
        STAGE: { value: stage },
        DEPLOY_SETTINGS: { value: JSON.stringify(props.deploySettings ?? {}) },
        DATABASE_URL: {
          type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
          value: databaseUrlName,
        },
        ...(dockerHub
          ? {
              DOCKERHUB_USERNAME: {
                type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
                value: `${props.dockerHubSecretName}:username`,
              },
              DOCKERHUB_TOKEN: {
                type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
                value: `${props.dockerHubSecretName}:token`,
              },
            }
          : {}),
      },
      timeout: Duration.minutes(45),
    });
    databaseUrl.grantRead(project);
    dockerHub?.grantRead(project);
    // `cdk deploy` works through the roles the CDK bootstrap created; the
    // build itself holds no other deploy rights.
    project.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-*-role-${this.account}-${this.region}`,
        ],
      })
    );
    project.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [
          this.formatArn({
            service: 'lambda',
            resource: 'function',
            resourceName: `zero-memory-${stage}-*`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      })
    );
    // The deploy script stamps each app's environment secret version into
    // its function; it reads the version, never the value.
    project.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:DescribeSecret'],
        resources: [
          this.formatArn({
            service: 'secretsmanager',
            resource: 'secret',
            resourceName: `zero-memory/${stage}/*-env-??????`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      })
    );

    const sourceOutput = new codepipeline.Artifact('Release');
    const source = new actions.CodeStarConnectionsSourceAction({
      actionName: 'GitHub',
      connectionArn: connection.attrConnectionArn,
      owner,
      repo,
      branch: props.branch,
      output: sourceOutput,
      // A full clone, so the build can name the release by its tag.
      codeBuildCloneOutput: true,
      triggerOnPush: false,
    });

    new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: `zero-memory-${stage}`,
      pipelineType: codepipeline.PipelineType.V2,
      artifactBucket: new s3.Bucket(this, 'Artifacts', {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        lifecycleRules: [{ expiration: Duration.days(30) }],
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
      }),
      stages: [
        { stageName: 'Source', actions: [source] },
        {
          stageName: 'Deploy',
          actions: [
            new actions.CodeBuildAction({
              actionName: 'Deploy',
              project,
              input: sourceOutput,
            }),
          ],
        },
      ],
      triggers: [
        {
          providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
          gitConfiguration: {
            sourceAction: source,
            pushFilter: [{ tagsIncludes: props.tagPatterns }],
          },
        },
      ],
    });

    new CfnOutput(this, 'ConnectionArn', {
      value: connection.attrConnectionArn,
    });
    new CfnOutput(this, 'DatabaseUrlSecret', { value: databaseUrlName });
  }
}
