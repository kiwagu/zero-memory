/**
 * Writes the server's environment into the stack's Secrets Manager secret.
 *
 *   AWS_PROFILE=<profile> bun scripts/server-env.put.ts <secret-name> <env-file>
 *
 * The env file holds KEY=value lines: SUPABASE_URL, SUPABASE_ANON_KEY,
 * SUPABASE_SERVICE_ROLE_KEY, ZM_WEB_URL and any model keys the server uses.
 * Keys already in the secret and absent from the file are kept, so the edge
 * header value the stack generated survives. Values are never printed.
 * Running instances keep the environment they started with; new ones read
 * the new value.
 */
import { readFileSync } from 'node:fs';

import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

const [secretId, envFile] = process.argv.slice(2);
if (!secretId || !envFile) {
  console.error('usage: server-env.put.ts <secret-name> <env-file>');
  process.exit(2);
}

const fromFile: Record<string, string> = {};
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (!match) {
    continue;
  }
  const [, key, raw] = match as unknown as [string, string, string];
  fromFile[key] = raw.replace(/^(['"])(.*)\1$/, '$2');
}

const client = new SecretsManagerClient({});
const { SecretString } = await client.send(
  new GetSecretValueCommand({ SecretId: secretId })
);
const current = JSON.parse(SecretString ?? '{}') as Record<string, string>;
const merged = { ...current, ...fromFile };
await client.send(
  new PutSecretValueCommand({
    SecretId: secretId,
    SecretString: JSON.stringify(merged),
  })
);
console.log(`wrote ${Object.keys(merged).sort().join(', ')} to ${secretId}`);
