import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { WebStack, type WebStackProps } from './web.stack.js';

const synth = (overrides: Partial<WebStackProps> = {}): Template =>
  Template.fromStack(
    new WebStack(new App(), 'zero-memory-web-test', {
      stage: 'test',
      webImage: 'zero-memory-web:test',
      webImageId: 'sha256:web',
      docsImage: 'zero-memory-docs:test',
      docsImageId: 'sha256:docs',
      env: { account: '111111111111', region: 'eu-north-1' },
      ...overrides,
    })
  );

describe('WebStack', () => {
  it('runs the dashboard and the docs, each behind its own edge', () => {
    const template = synth();
    template.resourceCountIs('AWS::Lambda::Function', 2);
    template.resourceCountIs('AWS::CloudFront::Distribution', 2);
    template.resourceCountIs('AWS::CloudFront::Function', 1);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'zero-memory/test/web-env',
      GenerateSecretString: Match.objectLike({
        GenerateStringKey: 'ZM_ORIGIN_VERIFY',
      }),
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'zero-memory/test/docs-env',
    });
  });

  it('tells the dashboard where the server is, and publishes where the dashboard is', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ZM_PARAMETERS: 'ZM_SERVER_URL=/zero-memory/test/mcp-url',
        }),
      },
    });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/zero-memory/test/web-url',
    });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/zero-memory/test/docs-url',
    });
  });

  it('gives each app the version of its own environment secret', () => {
    const template = synth({
      webEnvVersion: 'web-2',
      docsEnvVersion: 'docs-5',
    });
    for (const version of ['web-2', 'docs-5']) {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({ ZM_ENV_VERSION: version }),
        },
      });
    }
  });

  it('caches only the static files at the edge, and forwards cookies for the pages', () => {
    synth().hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
          CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
          OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
          FunctionAssociations: [
            Match.objectLike({ EventType: 'viewer-request' }),
          ],
        }),
        CacheBehaviors: [
          Match.objectLike({
            PathPattern: '/_next/static/*',
            CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6',
          }),
        ],
      }),
    });
  });

  it('sends mail through SES only from a domain it was given, and prints its DKIM records', () => {
    const silent = synth();
    silent.resourceCountIs('AWS::SES::EmailIdentity', 0);

    const template = synth({ mailDomain: 'example.com' });
    template.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: 'example.com',
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ZM_MAIL_TRANSPORT: 'ses',
          ZM_MAIL_FROM: 'zero-memory <noreply@example.com>',
        }),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['ses:SendEmail', 'ses:SendRawEmail'],
            Condition: {
              StringLike: { 'ses:FromAddress': '*@example.com' },
            },
          }),
        ]),
      }),
    });
    expect(
      Object.keys(template.findOutputs('*')).filter((key) =>
        key.startsWith('MailDkim')
      )
    ).toHaveLength(3);
  });

  it('refuses a domain without a certificate', () => {
    expect(() => synth({ webDomainName: 'app.example.com' })).toThrow(
      'web: domainName and certificateArn go together.'
    );
  });
});
