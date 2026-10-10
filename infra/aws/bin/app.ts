import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { App } from 'aws-cdk-lib';

import { PipelineStack } from '../src/pipeline.stack.js';
import { ServerStack } from '../src/server.stack.js';
import { WebStack } from '../src/web.stack.js';

const app = new App();

const contextValue = (key: string): string | undefined => {
  const value: unknown = app.node.tryGetContext(key);
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/**
 * A stage's settings live in `stages/<stage>.json` (git-ignored: they
 * describe one deployment), so every deploy of the stage — by hand or by its
 * pipeline — gets the same domains, mail sender and sizes. A `-c key=value`
 * on the command line wins over the file.
 */
const stageName = contextValue('stage') ?? 'stand';
const stageFile = join(
  dirname(fileURLToPath(import.meta.url)),
  '../stages',
  `${stageName}.json`
);
const stageSettings: Record<string, string> = existsSync(stageFile)
  ? (JSON.parse(readFileSync(stageFile, 'utf8')) as Record<string, string>)
  : {};

const context = (key: string, fallback: string): string =>
  contextValue(key) ?? stageSettings[key] ?? fallback;

const optional = (key: string): string | undefined => {
  const value = context(key, '');
  return value === '' ? undefined : value;
};

const stage = stageName;
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
  webEnvVersion: contextValue('webEnvVersion'),
  docsEnvVersion: contextValue('docsEnvVersion'),
  mailDomain: optional('mailDomain'),
  mailFrom: optional('mailFrom'),
  env,
});

const server = new ServerStack(app, `zero-memory-${stage}`, {
  stage,
  serverImage: context('serverImage', 'zero-memory-server'),
  serverImageId: context('serverImageId', 'unbuilt'),
  memorySize: memorySize === undefined ? undefined : Number(memorySize),
  envVersion: contextValue('serverEnvVersion'),
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
    deploySettings: stageSettings,
    env,
  });
}
