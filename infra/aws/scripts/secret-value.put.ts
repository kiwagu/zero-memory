/**
 * Writes one value from an env file into a Secrets Manager secret that holds
 * a plain string, such as the pipeline's database URL.
 *
 *   AWS_PROFILE=<profile> bun scripts/secret-value.put.ts <secret-name> <env-file> <KEY>
 *
 * The value is never printed.
 */
import { readFileSync } from 'node:fs';

import {
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

const [secretId, envFile, key] = process.argv.slice(2);
if (!secretId || !envFile || !key) {
  console.error('usage: secret-value.put.ts <secret-name> <env-file> <KEY>');
  process.exit(2);
}

let value: string | undefined;
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (match?.[1] === key) {
    value = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  }
}
if (!value) {
  console.error(`${key} has no value in ${envFile}`);
  process.exit(1);
}

await new SecretsManagerClient({}).send(
  new PutSecretValueCommand({ SecretId: secretId, SecretString: value })
);
console.log(`wrote ${key} to ${secretId}`);
