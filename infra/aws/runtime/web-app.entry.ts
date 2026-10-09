/**
 * Entry of a Next.js app (the dashboard or the documentation site) on AWS
 * Lambda behind the Lambda Web Adapter. The app's own image runs unchanged;
 * this script, added by `web-app.Dockerfile`, does what the docker host's
 * environment and edge do there:
 *
 * 1. loads configuration that cannot sit on the function itself: SSM
 *    parameters named in ZM_PARAMETERS (`ENV_NAME=/parameter/name,...`) and
 *    the JSON environment in the Secrets Manager secret ZM_ENV_SECRET_ID.
 *    A variable set on the function wins, then a parameter, then the secret;
 * 2. starts the app's Next.js server on an internal port and waits for it;
 * 3. answers the Web Adapter on AWS_LWA_PORT, passing on only requests that
 *    carry the edge's x-origin-verify value, with X-Forwarded-For rebuilt
 *    from the address the edge saw (x-viewer-address) and nothing a client
 *    wrote. The edge also sets X-Forwarded-Host to the name the browser used,
 *    which Next.js compares with Origin before it runs a Server Action.
 *    Bodies pass through as Next.js wrote them, compressed or not: decoding
 *    them here would leave Content-Encoding and Content-Length describing a
 *    body that is no longer there.
 *
 * The file system is read-only but /tmp, where Next's cache directory points.
 */
import { mkdirSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';

const EDGE_HEADER = 'x-origin-verify';
const VIEWER_HEADER = 'x-viewer-address';

const env = process.env;
const appDir = env.ZM_APP_DIR;
const appPort = Number(env.ZM_APP_PORT);
const listenPort = Number(env.AWS_LWA_PORT);
if (!appDir || !appPort || !listenPort) {
  throw new Error('ZM_APP_DIR, ZM_APP_PORT and AWS_LWA_PORT must be set.');
}

const fromFunction = new Set(Object.keys(env));

const parameterNames = (env.ZM_PARAMETERS ?? '')
  .split(',')
  .map((pair) => pair.trim().split('='))
  .filter((pair): pair is [string, string] => pair.length === 2);
if (parameterNames.length > 0) {
  const { Parameters = [], InvalidParameters = [] } = await new SSMClient(
    {}
  ).send(
    new GetParametersCommand({ Names: parameterNames.map(([, name]) => name) })
  );
  if (InvalidParameters.length > 0) {
    throw new Error(`Missing SSM parameters: ${InvalidParameters.join(', ')}`);
  }
  for (const [variable, name] of parameterNames) {
    const value = Parameters.find(
      (parameter) => parameter.Name === name
    )?.Value;
    if (value !== undefined && !fromFunction.has(variable)) {
      env[variable] = value;
    }
  }
}

if (env.ZM_ENV_SECRET_ID) {
  const { SecretString } = await new SecretsManagerClient({}).send(
    new GetSecretValueCommand({ SecretId: env.ZM_ENV_SECRET_ID })
  );
  const values = JSON.parse(SecretString ?? '{}') as Record<string, unknown>;
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'string' && env[name] === undefined) {
      env[name] = value;
    }
  }
}

mkdirSync('/tmp/next-cache', { recursive: true });

const app = Bun.spawn(['bun', `/app/${appDir}/server.js`], {
  env: { ...env, PORT: String(appPort), HOSTNAME: '127.0.0.1' },
  stdout: 'inherit',
  stderr: 'inherit',
});
void app.exited.then((code) => {
  console.error(`the app's server exited with ${code}`);
  process.exit(1);
});

const upstream = `http://127.0.0.1:${appPort}`;
for (let attempt = 0; ; attempt += 1) {
  const answered = await fetch(upstream, { method: 'HEAD' }).then(
    () => true,
    () => false
  );
  if (answered) {
    break;
  }
  if (attempt > 200) {
    throw new Error("The app's server did not start.");
  }
  await Bun.sleep(50);
}

const expected = env.ZM_ORIGIN_VERIFY;
const cameThroughEdge = (presented: string | null): boolean => {
  if (!expected) {
    return true;
  }
  if (presented === null) {
    return false;
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

Bun.serve({
  port: listenPort,
  // Next answers within the function's timeout; the edge cuts at 60 s.
  idleTimeout: 120,
  fetch: async (request) => {
    if (!cameThroughEdge(request.headers.get(EDGE_HEADER))) {
      return new Response('Forbidden', { status: 403 });
    }
    const headers = new Headers(request.headers);
    headers.delete(EDGE_HEADER);
    if (expected) {
      const viewer = headers.get(VIEWER_HEADER);
      headers.delete(VIEWER_HEADER);
      headers.delete('x-forwarded-for');
      if (viewer) {
        headers.set('x-forwarded-for', viewer);
      }
    }
    const url = new URL(request.url);
    return fetch(`${upstream}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
      decompress: false,
    });
  },
});
