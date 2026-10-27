import { timingSafeEqual } from 'node:crypto';

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  GetParameterCommand,
  ParameterNotFound,
  SSMClient,
} from '@aws-sdk/client-ssm';

/** The header the edge adds to every request it forwards to the function. */
export const EDGE_HEADER = 'x-origin-verify';

/**
 * The header the edge sets to the address it saw the request come from,
 * overwriting any value a client sent under that name.
 */
export const VIEWER_HEADER = 'x-viewer-address';

/**
 * Loads the function's configuration from where it lives on AWS, once per
 * instance and before the server is composed:
 *
 * - `ZM_PUBLIC_URL_PARAMETER` names an SSM parameter holding the public URL.
 *   That URL is the edge's address, which exists only after the function
 *   does, so it cannot be set on the function itself;
 * - `ZM_WEB_URL_PARAMETER` names the parameter holding the dashboard's
 *   address, published by the stack that runs the dashboard. Until that
 *   stack exists the parameter does not either, and ZM_WEB_URL comes from
 *   the secret instead;
 * - `ZM_ENV_SECRET_ID` names a Secrets Manager secret holding a JSON object
 *   of environment variables (the Supabase keys, the edge header's value), so
 *   no secret is part of the function's configuration.
 *
 * A variable set on the function wins, then a parameter, then the secret.
 */
export interface RuntimeConfigClients {
  ssm: Pick<SSMClient, 'send'>;
  secrets: Pick<SecretsManagerClient, 'send'>;
}

export const loadRuntimeConfig = async (
  env: NodeJS.ProcessEnv = process.env,
  clients: RuntimeConfigClients = {
    ssm: new SSMClient({}),
    secrets: new SecretsManagerClient({}),
  }
): Promise<void> => {
  const { ssm, secrets } = clients;
  const fromParameter = async (
    variable: string,
    name: string | undefined,
    required: boolean
  ): Promise<void> => {
    if (!name || env[variable]) {
      return;
    }
    try {
      const { Parameter } = await ssm.send(
        new GetParameterCommand({ Name: name })
      );
      if (Parameter?.Value) {
        env[variable] = Parameter.Value;
      }
    } catch (error) {
      if (required || !(error instanceof ParameterNotFound)) {
        throw error;
      }
    }
  };
  await fromParameter('ZM_PUBLIC_URL', env.ZM_PUBLIC_URL_PARAMETER, true);
  await fromParameter('ZM_WEB_URL', env.ZM_WEB_URL_PARAMETER, false);

  const secretId = env.ZM_ENV_SECRET_ID;
  if (secretId) {
    // The version the deploy stamped into the function is the one the edge
    // presents its header from; the current one may already be newer.
    const version = env.ZM_ENV_VERSION;
    const { SecretString } = await secrets.send(
      new GetSecretValueCommand({
        SecretId: secretId,
        ...(version ? { VersionId: version } : {}),
      })
    );
    const values = JSON.parse(SecretString ?? '{}') as Record<string, unknown>;
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === 'string' && env[name] === undefined) {
        env[name] = value;
      }
    }
  }
};

/**
 * Whether a request came through the edge: it carries the header the edge
 * adds, with the shared value. The function's own URL stays reachable from
 * the internet, so without this anyone could skip the edge and, among other
 * things, choose the X-Forwarded-For the rate limiter keys on. Without a
 * shared value nothing passes.
 */
export const cameThroughEdge = (
  presented: string | undefined,
  expected: string
): boolean => {
  if (!expected || presented === undefined) {
    return false;
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * The value the edge must present. A missing or empty one is a broken
 * configuration, never "no edge": the function URL stays reachable from the
 * internet, so failing open would let anyone past the edge and pick their own
 * rate-limit address. The function refuses to start instead. Only a local
 * emulator, which has no edge, turns the check off, and only by saying so:
 * `ZM_EDGE_CHECK=off`.
 */
export const edgeSecretFrom = (
  env: Readonly<Record<string, string | undefined>>
): string | null => {
  if (env.ZM_EDGE_CHECK === 'off') {
    return null;
  }
  const value = env.ZM_ORIGIN_VERIFY;
  if (!value) {
    throw new Error(
      'ZM_ORIGIN_VERIFY is not set: the function would answer requests that skipped the edge. Set it, or ZM_EDGE_CHECK=off for a local emulator without an edge.'
    );
  }
  return value;
};

/**
 * Makes X-Forwarded-For say what the edge saw, and nothing a client wrote.
 * The edge forwards a client's own X-Forwarded-For with the real address
 * appended, and the server reads the first hop, so trusting the header as it
 * arrives would let anyone pick a fresh rate-limit bucket per request. The
 * header is replaced with the edge's observation, or removed when there is
 * none, which leaves every such request in one shared bucket.
 */
export const forwardedForFromEdge = (
  headers: Record<string, string | undefined>
): void => {
  const viewer = headers[VIEWER_HEADER];
  delete headers[VIEWER_HEADER];
  delete headers['x-forwarded-for'];
  if (viewer) {
    headers['x-forwarded-for'] = viewer;
  }
};
