import { describe, expect, it } from 'vitest';

import { ParameterNotFound } from '@aws-sdk/client-ssm';

import {
  cameThroughEdge,
  forwardedForFromEdge,
  loadRuntimeConfig,
  VIEWER_HEADER,
  type RuntimeConfigClients,
} from './lambda.config.js';

describe('forwardedForFromEdge', () => {
  it("replaces a client's own X-Forwarded-For with the address the edge saw", () => {
    const headers: Record<string, string | undefined> = {
      'x-forwarded-for': '198.51.100.7, 203.0.113.9',
      [VIEWER_HEADER]: '203.0.113.9',
    };
    forwardedForFromEdge(headers);
    expect(headers).toEqual({ 'x-forwarded-for': '203.0.113.9' });
  });

  it('drops X-Forwarded-For when the edge named no address', () => {
    const headers: Record<string, string | undefined> = {
      'x-forwarded-for': '198.51.100.7',
    };
    forwardedForFromEdge(headers);
    expect(headers).toEqual({});
  });
});

describe('cameThroughEdge', () => {
  it('passes everything when no edge is configured', () => {
    expect(cameThroughEdge(undefined, undefined)).toBe(true);
  });

  it('needs the exact shared value when one is', () => {
    expect(cameThroughEdge('secret', 'secret')).toBe(true);
    expect(cameThroughEdge('secreT', 'secret')).toBe(false);
    expect(cameThroughEdge('secret-longer', 'secret')).toBe(false);
    expect(cameThroughEdge(undefined, 'secret')).toBe(false);
  });
});

/** Fakes that answer GetParameter by name and GetSecretValue with JSON. */
const clients = (
  parameters: Record<string, string>,
  secret: Record<string, string>
): RuntimeConfigClients =>
  ({
    ssm: {
      send: async (command: { input: { Name: string } }) => {
        const value = parameters[command.input.Name];
        if (value === undefined) {
          throw new ParameterNotFound({ message: 'missing', $metadata: {} });
        }
        return { Parameter: { Value: value } };
      },
    },
    secrets: {
      send: async () => ({ SecretString: JSON.stringify(secret) }),
    },
  }) as unknown as RuntimeConfigClients;

describe('loadRuntimeConfig', () => {
  const base = {
    ZM_PUBLIC_URL_PARAMETER: '/zm/test/public-url',
    ZM_WEB_URL_PARAMETER: '/zm/test/web-url',
    ZM_ENV_SECRET_ID: 'zm/test/server-env',
  };

  it('takes the function first, then a parameter, then the secret', async () => {
    const env: NodeJS.ProcessEnv = { ...base, SUPABASE_URL: 'from-function' };
    await loadRuntimeConfig(
      env,
      clients(
        {
          '/zm/test/public-url': 'https://api.test',
          '/zm/test/web-url': 'https://app.test',
        },
        {
          ZM_WEB_URL: 'https://from-secret.test',
          SUPABASE_URL: 'from-secret',
          SUPABASE_ANON_KEY: 'anon',
        }
      )
    );
    expect(env.ZM_PUBLIC_URL).toBe('https://api.test');
    expect(env.ZM_WEB_URL).toBe('https://app.test');
    expect(env.SUPABASE_URL).toBe('from-function');
    expect(env.SUPABASE_ANON_KEY).toBe('anon');
  });

  it('falls to the secret for the dashboard while its parameter does not exist', async () => {
    const env: NodeJS.ProcessEnv = { ...base };
    await loadRuntimeConfig(
      env,
      clients(
        { '/zm/test/public-url': 'https://api.test' },
        { ZM_WEB_URL: 'https://from-secret.test' }
      )
    );
    expect(env.ZM_WEB_URL).toBe('https://from-secret.test');
  });

  it('refuses to start without the public URL parameter', async () => {
    await expect(
      loadRuntimeConfig({ ...base }, clients({}, {}))
    ).rejects.toBeInstanceOf(ParameterNotFound);
  });
});
