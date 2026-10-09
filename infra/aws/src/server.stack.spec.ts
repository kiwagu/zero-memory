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
    silent.resourceCountIs('AWS::CloudWatch::Alarm', 5);
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

  it('takes the memory size it is given', () => {
    synth({ memorySize: 2048 }).hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 2048,
    });
  });

  it("overwrites the viewer's address header at the edge, on every request", () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionCode: Match.stringLikeRegexp(
        "headers\\['x-viewer-address'\\] = \\{ value: event\\.viewer\\.ip \\}"
      ),
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
