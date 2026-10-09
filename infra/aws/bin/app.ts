import { App } from 'aws-cdk-lib';

import { PipelineStack } from '../src/pipeline.stack.js';
import { ServerStack } from '../src/server.stack.js';
import { WebStack } from '../src/web.stack.js';

const app = new App();

const context = (key: string, fallback: string): string => {
  const value: unknown = app.node.tryGetContext(key);
  return typeof value === 'string' && value !== '' ? value : fallback;
};

const optional = (key: string): string | undefined => {
  const value = context(key, '');
  return value === '' ? undefined : value;
};

const stage = context('stage', 'stand');
const memorySize = optional('memorySize');

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'eu-central-1',
};

// The dashboard and the docs first: the server reads the dashboard's address
// when it starts.
const web = new WebStack(app, `zero-memory-web-${stage}`, {
  stage,
  webImage: context('webImage', 'zero-memory-web'),
  webImageId: context('webImageId', 'unbuilt'),
  docsImage: context('docsImage', 'zero-memory-docs'),
  docsImageId: context('docsImageId', 'unbuilt'),
  webDomainName: optional('webDomainName'),
  webCertificateArn: optional('webCertificateArn'),
  docsDomainName: optional('docsDomainName'),
  docsCertificateArn: optional('docsCertificateArn'),
  env,
});

const server = new ServerStack(app, `zero-memory-${stage}`, {
  stage,
  serverImage: context('serverImage', 'zero-memory-server'),
  serverImageId: context('serverImageId', 'unbuilt'),
  memorySize: memorySize === undefined ? undefined : Number(memorySize),
  domainName: optional('domainName'),
  certificateArn: optional('certificateArn'),
  alarmEmail: optional('alarmEmail'),
  env,
});
server.addDependency(web);

// The pipeline that deploys this stage from release tags, when a repository
// is named: `-c githubRepo=<owner/name>`.
const githubRepo = optional('githubRepo');
if (githubRepo) {
  new PipelineStack(app, `zero-memory-pipeline-${stage}`, {
    stage,
    repository: githubRepo,
    branch: context('githubBranch', 'main'),
    tagPatterns: context('releaseTags', 'v*').split(','),
    dockerHubSecretName: optional('dockerHubSecret'),
    env,
  });
}
