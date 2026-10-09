import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { PipelineStack, type PipelineStackProps } from './pipeline.stack.js';

const synth = (overrides: Partial<PipelineStackProps> = {}): Template =>
  Template.fromStack(
    new PipelineStack(new App(), 'zero-memory-pipeline-test', {
      stage: 'test',
      repository: 'example/repo',
      branch: 'main',
      tagPatterns: ['v*'],
      env: { account: '111111111111', region: 'eu-north-1' },
      ...overrides,
    })
  );

describe('PipelineStack', () => {
  it('starts on release tags pushed to the GitHub repository', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CodeStarConnections::Connection', {
      ProviderType: 'GitHub',
    });
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      PipelineType: 'V2',
      Triggers: [
        Match.objectLike({
          ProviderType: 'CodeStarSourceConnection',
          GitConfiguration: Match.objectLike({
            Push: [{ Tags: { Includes: ['v*'] } }],
          }),
        }),
      ],
      Stages: [
        Match.objectLike({
          Name: 'Source',
          Actions: [
            Match.objectLike({
              Configuration: Match.objectLike({
                FullRepositoryId: 'example/repo',
                BranchName: 'main',
                OutputArtifactFormat: 'CODEBUILD_CLONE_REF',
                DetectChanges: false,
              }),
            }),
          ],
        }),
        Match.objectLike({ Name: 'Deploy' }),
      ],
    });
  });

  it('builds with Docker from the repository buildspec, the database URL from its secret', () => {
    synth().hasResourceProperties('AWS::CodeBuild::Project', {
      Source: Match.objectLike({ BuildSpec: 'infra/aws/buildspec.yml' }),
      Environment: Match.objectLike({
        PrivilegedMode: true,
        EnvironmentVariables: Match.arrayWith([
          { Name: 'STAGE', Type: 'PLAINTEXT', Value: 'test' },
          {
            Name: 'DATABASE_URL',
            Type: 'SECRETS_MANAGER',
            Value: 'zero-memory/test/database-url',
          },
        ]),
      }),
    });
  });

  it('lets the build assume only the CDK bootstrap roles and invoke its own stage', () => {
    const statements = Object.values(
      synth().findResources('AWS::IAM::Policy')
    ).flatMap(
      (policy) =>
        (
          policy as {
            Properties: { PolicyDocument: { Statement: unknown[] } };
          }
        ).Properties.PolicyDocument.Statement
    );
    const rendered = JSON.stringify(statements);
    expect(rendered).toContain(
      'role/cdk-hnb659fds-*-role-111111111111-eu-north-1'
    );
    expect(rendered).toContain('function:zero-memory-test-*');
    expect(rendered).not.toMatch(/"Action":"\*"/);
  });

  it('passes Docker Hub credentials only when a secret is named', () => {
    synth({ dockerHubSecretName: 'ci/dockerhub' }).hasResourceProperties(
      'AWS::CodeBuild::Project',
      {
        Environment: Match.objectLike({
          EnvironmentVariables: Match.arrayWith([
            Match.objectLike({
              Name: 'DOCKERHUB_TOKEN',
              Value: 'ci/dockerhub:token',
            }),
          ]),
        }),
      }
    );
  });

  it('refuses a repository that is not owner/name', () => {
    expect(() => synth({ repository: 'repo' })).toThrow(
      'repository must be owner/name.'
    );
  });
});
