import { timingSafeEqual } from 'node:crypto';

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/** The header the edge adds to every request it forwards to the function. */
export const EDGE_HEADER = 'x-origin-verify';

/**
 * Loads the function's configuration from where it lives on AWS, once per
 * instance and before the server is composed:
 *
 * - `ZM_ENV_SECRET_ID` names a Secrets Manager secret holding a JSON object
 *   of environment variables (the Supabase keys, the dashboard URL, the edge
 *   header's value), so no secret is part of the function's configuration;
 * - `ZM_PUBLIC_URL_PARAMETER` names an SSM parameter holding the public URL.
 *   That URL is the edge's address, which exists only after the function
 *   does, so it cannot be set on the function itself.
 *
 * A variable already set in the environment wins over the secret.
 */
export const loadRuntimeConfig = async (
  env: NodeJS.ProcessEnv = process.env
): Promise<void> => {
  const secretId = env.ZM_ENV_SECRET_ID;
  if (secretId) {
    const { SecretString } = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: secretId })
    );
    const values = JSON.parse(SecretString ?? '{}') as Record<string, unknown>;
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === 'string' && env[name] === undefined) {
        env[name] = value;
      }
    }
  }
  const parameter = env.ZM_PUBLIC_URL_PARAMETER;
  if (parameter && !env.ZM_PUBLIC_URL) {
    const { Parameter } = await new SSMClient({}).send(
      new GetParameterCommand({ Name: parameter })
    );
    if (Parameter?.Value) {
      env.ZM_PUBLIC_URL = Parameter.Value;
    }
  }
};

/**
 * Whether a request came through the edge: it carries the header the edge
 * adds, with the shared value. The function's own URL stays reachable from
 * the internet, so without this anyone could skip the edge and, among other
 * things, choose the X-Forwarded-For the rate limiter keys on. No configured
 * value means no edge in front, and every request passes.
 */
export const cameThroughEdge = (
  presented: string | undefined,
  expected: string | undefined
): boolean => {
  if (!expected) {
    return true;
  }
  if (presented === undefined) {
    return false;
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
