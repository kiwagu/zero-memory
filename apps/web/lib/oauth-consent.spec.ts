import { CROCKFORD_CANONICAL_CLASS } from 'entity-id';
import { describe, expect, it, vi } from 'vitest';

import {
  AUTHORIZATION_ID_RE,
  decideAuthorization,
  readAuthorization,
  returnHost,
  screenlessArrival,
} from './oauth-consent';

const ID = 'oaa_a1b2c3d4e5f6g7h8.01jd8x2p4q';

const respond = (status: number, body: unknown) =>
  vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
  );

const details = {
  authorization_id: ID,
  client: { client_id: 'oac_a1b2c3d4e5f6g7h8.01jd8x2p4q', client_name: 'zm' },
  scope: 'mcp:read mcp:write',
  redirect_uri: 'http://127.0.0.1:4000/callback',
  expires_at: '2026-10-03T12:10:00.000Z',
};

describe('the authorization id from the consent URL', () => {
  it('keeps the canonical Crockford class of the id contract', () => {
    expect(
      AUTHORIZATION_ID_RE.source.split(CROCKFORD_CANONICAL_CLASS).length - 1
    ).toBe(2);
  });

  it('accepts an oaa_ id and nothing else', () => {
    expect(AUTHORIZATION_ID_RE.test(ID)).toBe(true);
    expect(AUTHORIZATION_ID_RE.test('oac_a1b2c3d4e5f6g7h8.01jd8x2p4q')).toBe(
      false
    );
    expect(AUTHORIZATION_ID_RE.test(`${ID}/../x`)).toBe(false);
  });
});

describe('screenlessArrival', () => {
  it('skips the screen only when the browser arrived on its own or from this origin', () => {
    expect(screenlessArrival('none')).toBe(true);
    expect(screenlessArrival('same-origin')).toBe(true);
    expect(screenlessArrival('same-site')).toBe(false);
    expect(screenlessArrival('cross-site')).toBe(false);
    expect(screenlessArrival(null)).toBe(false);
  });
});

describe('readAuthorization', () => {
  it('tells the server when the screen may be skipped', async () => {
    const skip = respond(200, details);
    await readAuthorization('tok', ID, { screenless: true }, skip);
    expect(String(skip.mock.calls[0]![0])).toMatch(/\?screenless=1$/);
    const show = respond(200, details);
    await readAuthorization('tok', ID, { screenless: false }, show);
    expect(String(show.mock.calls[0]![0])).not.toContain('screenless');
  });
  it('sends the dashboard session as the bearer and reads the details', async () => {
    const fetchImpl = respond(200, details);
    const result = await readAuthorization(
      'tok',
      ID,
      { screenless: false },
      fetchImpl
    );
    expect(result).toEqual({ kind: 'details', details });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toMatch(new RegExp(`/oauth/authorizations/${ID}$`));
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok');
    expect(init?.cache).toBe('no-store');
  });

  it('follows a stored consent straight back to the client', async () => {
    const url = 'http://127.0.0.1:4000/callback?code=c&state=s';
    const result = await readAuthorization(
      'tok',
      ID,
      { screenless: false },
      respond(200, { redirect_url: url })
    );
    expect(result).toEqual({ kind: 'redirect', url });
  });

  it('never follows a script-bearing redirect, whatever the server says', async () => {
    for (const url of [
      'javascript:alert(document.cookie)//?code=c',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
    ]) {
      expect(
        await readAuthorization(
          'tok',
          ID,
          { screenless: false },
          respond(200, { redirect_url: url })
        )
      ).toEqual({ kind: 'failed' });
    }
  });

  it('maps a missing request, and anything unexpected, to typed outcomes', async () => {
    expect(
      await readAuthorization(
        'tok',
        ID,
        { screenless: false },
        respond(404, { error: 'not_found' })
      )
    ).toEqual({ kind: 'gone' });
    // A server without the consent API answers its own 404 shape: that is a
    // dashboard pointed at the wrong server, not an expired request.
    expect(
      await readAuthorization(
        'tok',
        ID,
        { screenless: false },
        respond(404, { error: { code: 'not_found', message: 'No route' } })
      )
    ).toEqual({ kind: 'failed' });
    expect(
      await readAuthorization(
        'tok',
        ID,
        { screenless: false },
        respond(200, { surprise: true })
      )
    ).toEqual({ kind: 'failed' });
    expect(
      await readAuthorization(
        'tok',
        ID,
        { screenless: false },
        respond(503, { error: 'x' })
      )
    ).toEqual({ kind: 'failed' });
  });
});

describe('decideAuthorization', () => {
  it('posts the decision and returns where the browser goes', async () => {
    const url = 'http://127.0.0.1:4000/callback?error=access_denied';
    const fetchImpl = respond(200, { redirect_url: url });
    expect(await decideAuthorization('tok', ID, 'deny', fetchImpl)).toEqual({
      kind: 'redirect',
      url,
    });
    const [target, init] = fetchImpl.mock.calls[0]!;
    expect(String(target)).toMatch(/\/consent$/);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ decision: 'deny' });
  });

  it('reports a request that is no longer pending as gone', async () => {
    for (const [status, error] of [
      [404, 'not_found'],
      [409, 'invalid_request'],
    ] as const) {
      expect(
        await decideAuthorization(
          'tok',
          ID,
          'approve',
          respond(status, { error })
        )
      ).toEqual({ kind: 'gone' });
    }
  });
});

describe('what the consent screen says', () => {
  it('names the host the browser returns to', () => {
    expect(returnHost('http://127.0.0.1:41241/callback')).toBe('127.0.0.1');
    expect(returnHost('https://claude.ai/api/mcp/auth_callback')).toBe(
      'claude.ai'
    );
    expect(returnHost('cursor://anysphere.cursor-mcp/oauth/callback')).toBe(
      'cursor://anysphere.cursor-mcp'
    );
  });
});
