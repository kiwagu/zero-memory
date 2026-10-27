import { describe, expect, it } from 'vitest';

import { callbackOutcome } from './login.js';

const STATE = 'this-login-state';

const callback = (params: Record<string, string | undefined>): URL => {
  const url = new URL('http://127.0.0.1:40123/callback');
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(name, value);
    }
  }
  return url;
};

describe('callbackOutcome', () => {
  it('hands over the code when the answer carries this login’s state', () => {
    expect(
      callbackOutcome(callback({ code: 'abc', state: STATE }), STATE)
    ).toMatchObject({ status: 200, result: { code: 'abc' } });
  });

  it('ignores a code that comes without this login’s state, and keeps waiting', () => {
    for (const params of [{ code: 'abc' }, { code: 'abc', state: 'other' }]) {
      const outcome = callbackOutcome(callback(params), STATE);
      expect(outcome.status).toBe(400);
      expect(outcome.result).toBeUndefined();
    }
  });

  it('ignores an error that does not belong to this login', () => {
    const outcome = callbackOutcome(
      callback({ error: 'access_denied', state: 'other' }),
      STATE
    );
    expect(outcome.result).toBeUndefined();
  });

  it('never writes what the request sent into the page', () => {
    const planted = '<script>alert(1)</script>';
    for (const params of [
      { error: planted, state: STATE },
      { error: planted },
      { code: planted, state: 'other' },
    ]) {
      expect(callbackOutcome(callback(params), STATE).body).not.toContain(
        'script'
      );
    }
  });

  it('reduces an unrecognized error to a plain token for the terminal', () => {
    expect(
      callbackOutcome(
        callback({ error: 'denied\u001b[2J', state: STATE }),
        STATE
      ).result
    ).toEqual({ error: 'unrecognized_error' });
    expect(
      callbackOutcome(callback({ error: 'access_denied', state: STATE }), STATE)
        .result
    ).toEqual({ error: 'access_denied' });
  });

  it('answers 404 off the callback path', () => {
    expect(
      callbackOutcome(new URL('http://127.0.0.1:40123/other'), STATE).status
    ).toBe(404);
  });
});
