import { App } from 'aws-cdk-lib';

import { ServerStack } from '../src/server.stack.js';

const app = new App();

const context = (key: string, fallback: string): string => {
  const value: unknown = app.node.tryGetContext(key);
  return typeof value === 'string' && value !== '' ? value : fallback;
};

const stage = context('stage', 'stand');

new ServerStack(app, `zero-memory-${stage}`, {
  stage,
  serverImage: context('serverImage', 'zero-memory-server'),
  serverImageId: context('serverImageId', 'unbuilt'),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'eu-central-1',
  },
});
