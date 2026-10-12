/**
 * Entry of the database backup function on AWS Lambda (backup.Dockerfile).
 * Each invocation runs the container host's dump script
 * (`infra/prod/scripts/db-dump.sh`) unchanged and keeps what it wrote in S3,
 * so the artifact, its checks and its manifest are exactly the ones the
 * restore script takes:
 *
 * - DATABASE_URL comes from the JSON secret ZM_ENV_SECRET_ID. The function
 *   reaches the internet over IPv4 only, so for a Supabase project it is the
 *   session pooler's address;
 * - the newest stored manifest is put next to the new dump first, so the
 *   script can warn when the row count fell sharply since the last backup;
 * - the artifact and its manifest go under `daily/`, and the first backup of
 *   each month is also copied under `monthly/`. The bucket's lifecycle rules
 *   expire both;
 * - success is logged as `backup stored`, which the stack's dead-man alarm
 *   counts; a failure is the invocation's error, which another alarm counts.
 */
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  CopyObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

const env = process.env;
const runtimeApi = env.AWS_LAMBDA_RUNTIME_API;
const bucket = env.ZM_BACKUP_BUCKET;
const secretId = env.ZM_ENV_SECRET_ID;
if (!runtimeApi || !bucket || !secretId) {
  throw new Error(
    'AWS_LAMBDA_RUNTIME_API, ZM_BACKUP_BUCKET and ZM_ENV_SECRET_ID must be set.'
  );
}
const SCRIPT = '/opt/zm-backup/db-dump.sh';
const invocationUrl = `http://${runtimeApi}/2018-06-01/runtime/invocation`;

const s3 = new S3Client({});
const secrets = new SecretsManagerClient({});

/** One JSON line per event, in the shape the server's own logger writes. */
const log = (
  level: 'info' | 'error',
  msg: string,
  fields: Record<string, unknown> = {}
): void => {
  console.log(
    JSON.stringify({
      level,
      time: new Date().toISOString(),
      name: 'backup',
      msg,
      ...fields,
    })
  );
};

let databaseUrl: string | undefined;
const loadDatabaseUrl = async (): Promise<string> => {
  if (databaseUrl) {
    return databaseUrl;
  }
  const { SecretString } = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretId })
  );
  const value = (JSON.parse(SecretString ?? '{}') as Record<string, string>)
    .DATABASE_URL;
  if (!value) {
    throw new Error(`${secretId} holds no DATABASE_URL.`);
  }
  databaseUrl = value;
  return value;
};

/** Keys under a prefix, oldest first: artifact names start with their time. */
const keysUnder = async (prefix: string): Promise<string[]> => {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    for (const object of page.Contents ?? []) {
      if (object.Key) {
        keys.push(object.Key);
      }
    }
    token = page.NextContinuationToken;
  } while (token);
  return keys.sort();
};

const fetchNewestManifest = async (dir: string): Promise<void> => {
  const newest = (await keysUnder('daily/'))
    .filter((key) => key.endsWith('.manifest.json'))
    .at(-1);
  if (!newest) {
    return;
  }
  const { Body } = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: newest })
  );
  if (Body) {
    writeFileSync(
      join(dir, newest.slice('daily/'.length)),
      await Body.transformToString()
    );
  }
};

const store = async (key: string, file: string, contentType: string) => {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: readFileSync(file),
      ContentType: contentType,
    })
  );
};

const backUp = async () => {
  const url = await loadDatabaseUrl();
  const dir = mkdtempSync('/tmp/zm-backup-');
  try {
    await fetchNewestManifest(dir);
    const exitCode = await Bun.spawn(['bash', SCRIPT, 'dump'], {
      env: {
        PATH: env.PATH,
        HOME: '/tmp',
        SUPABASE_DB_URL: url,
        // The image carries its own Postgres 17 client; there is no Docker.
        ZM_PG_LOCAL: '1',
        ZM_DUMP_DIR: dir,
        ZM_DUMP_KEEP: '1',
      },
      stdout: 'inherit',
      stderr: 'inherit',
    }).exited;
    if (exitCode !== 0) {
      throw new Error(`db-dump.sh exited with ${exitCode}`);
    }
    const artifact = readdirSync(dir).find((name) =>
      name.endsWith('_zm-data.sql.gz')
    );
    if (!artifact) {
      throw new Error('db-dump.sh succeeded but left no artifact');
    }
    const manifest = artifact.replace(/\.sql\.gz$/, '.manifest.json');
    await store(`daily/${artifact}`, join(dir, artifact), 'application/gzip');
    await store(`daily/${manifest}`, join(dir, manifest), 'application/json');

    // Artifact names start with the date, so the month is their first part.
    // The month is kept once its manifest is: the artifact is copied first, so
    // a run cut between the two leaves no manifest and the next run copies a
    // whole pair again.
    const month = artifact.slice(0, 7);
    const monthly = !(await keysUnder(`monthly/${month}`)).some((key) =>
      key.endsWith('.manifest.json')
    );
    if (monthly) {
      for (const name of [artifact, manifest]) {
        await s3.send(
          new CopyObjectCommand({
            Bucket: bucket,
            Key: `monthly/${name}`,
            CopySource: `${bucket}/daily/${encodeURIComponent(name)}`,
          })
        );
      }
    }

    const { bytes, rows_total } = JSON.parse(
      readFileSync(join(dir, manifest), 'utf8')
    ) as { bytes: number; rows_total: number };
    const result = { key: `daily/${artifact}`, bytes, rows_total, monthly };
    log('info', 'backup stored', result);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

for (;;) {
  const next = await fetch(`${invocationUrl}/next`);
  const invocationId = next.headers.get('lambda-runtime-aws-request-id');
  // The schedule's event carries nothing the backup uses.
  await next.text();
  try {
    const result = await backUp();
    await fetch(`${invocationUrl}/${invocationId}/response`, {
      method: 'POST',
      body: JSON.stringify(result),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('error', 'backup failed', { error: message });
    await fetch(`${invocationUrl}/${invocationId}/error`, {
      method: 'POST',
      headers: { 'lambda-runtime-function-error-type': 'Runtime.HandlerError' },
      body: JSON.stringify({
        errorMessage: message,
        errorType: 'BackupFailed',
      }),
    });
  }
}
