import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { auth } from '@modelcontextprotocol/sdk/client/auth.js';

import { FileOAuthProvider } from './file-oauth-provider.js';
import { OAuthStateStore } from './state-store.js';

/** Best-effort browser open; headless boxes just use the printed URL. */
const openBrowser = (url: string): void => {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
  try {
    const child = spawn(command, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // ignore — the URL is printed regardless
  }
};

/** What the loopback callback answers, and what it means for the login. */
export interface CallbackOutcome {
  status: number;
  /** Plain text: nothing from the request is ever written back into it. */
  body: string;
  /** Absent when the request is not an answer to this login at all. */
  result?: { code: string } | { error: string };
}

/**
 * Reads one request to the loopback callback.
 *
 * Only an answer carrying this login's own `state` counts. Anything else —
 * a page or a script on the same machine sending a code, or an error, it made
 * up — is refused and the login keeps waiting for the real answer instead of
 * finishing on someone else's code or giving up on someone else's error. The
 * page the browser shows is fixed text; the error a server sent is reduced to
 * a plain token before it reaches the terminal.
 */
export const callbackOutcome = (
  url: URL,
  expectedState: string
): CallbackOutcome => {
  if (url.pathname !== '/callback') {
    return { status: 404, body: 'Not found.' };
  }
  if (url.searchParams.get('state') !== expectedState) {
    return {
      status: 400,
      body:
        'This response does not belong to the login waiting here. ' +
        'You can close this tab.',
    };
  }
  const error = url.searchParams.get('error');
  if (error) {
    return {
      status: 200,
      body: 'zero-memory was not authorized. You can close this tab.',
      result: {
        error: /^[a-z_]{1,64}$/.test(error) ? error : 'unrecognized_error',
      },
    };
  }
  const code = url.searchParams.get('code');
  if (!code) {
    return {
      status: 400,
      body: 'The response carried no authorization code. You can close this tab.',
      result: { error: 'missing_code' },
    };
  }
  return {
    status: 200,
    body: 'zero-memory authorized. You can close this tab.',
    result: { code },
  };
};

/**
 * Interactive one-time login: dynamic client registration + PKCE authorization
 * code against the MCP server's embedded OAuth server, capturing the redirect
 * on a loopback port. Tokens land in the shared state file; afterwards the
 * watcher and hooks run headlessly and refresh on their own.
 */
export const runLogin = async (serverUrl: string): Promise<void> => {
  const store = new OAuthStateStore();

  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  // A fresh value per login: the callback must carry it back.
  const expectedState = randomBytes(32).toString('base64url');

  const server = createServer((req, res) => {
    const outcome = callbackOutcome(
      new URL(req.url ?? '/', 'http://127.0.0.1'),
      expectedState
    );
    res.statusCode = outcome.status;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('x-content-type-options', 'nosniff');
    res.end(outcome.body);
    if (!outcome.result) {
      return;
    }
    if ('code' in outcome.result) {
      resolveCode(outcome.result.code);
    } else {
      rejectCode(new Error(`authorization error: ${outcome.result.error}`));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const provider = new FileOAuthProvider({
    serverUrl,
    redirectUri,
    store,
    state: expectedState,
    onAuthorizationRequired: (authorizationUrl) => {
      console.log(
        `\nOpen this URL to authorize zero-memory:\n\n  ${authorizationUrl.toString()}\n`
      );
      openBrowser(authorizationUrl.toString());
    },
  });

  // The authorization round trip, as one unit so it can be retried on a clean
  // slate. `codeConsumed` guards the retry: the callback server delivers
  // exactly ONE code, so an attempt that already took it must not be replayed —
  // the second run would wait forever for a code nobody is going to send. The
  // failure this retry exists for (a rejected stale client_id) happens before
  // the code is ever requested, so the guard costs nothing in that case.
  let codeConsumed = false;
  const authorize = async (): Promise<void> => {
    const result = await auth(provider, { serverUrl });
    if (result === 'AUTHORIZED') {
      console.log('Already authorized — tokens are current.');
      return;
    }
    codeConsumed = true;
    const code = await codePromise;
    const finalResult = await auth(provider, {
      serverUrl,
      authorizationCode: code,
    });
    if (finalResult !== 'AUTHORIZED') {
      throw new Error(`unexpected auth result: ${finalResult}`);
    }
    console.log('Login complete — tokens stored.');
  };

  // A login REUSES the registration this machine already holds, and only
  // re-registers when that fails.
  //
  // The previous version dropped the stored registration unconditionally, and
  // that cost more than it looked: dynamic client registration mints a new
  // client_id per request, and a native client binds a FRESH ephemeral port for
  // its loopback redirect every time, so each login wrote another row on the
  // server that nothing ever removed. Measured on production 2026-08-19: 47
  // registrations for this one client. Reusing costs nothing when it works —
  // the server compares loopback redirects ignoring the port (RFC 8252 §7.3),
  // so a registration made on one port authorizes a login on another.
  //
  // The clean-slate path is KEPT as the fallback, because the reason it was
  // added is real: a stored client_id can be stale (the server's clients were
  // reset, or its id format changed) and is then replayed and rejected —
  // "Invalid entity id" — rather than recovered. That case now costs one extra
  // round trip instead of being paid on every login by everyone.
  try {
    await authorize();
  } catch (error) {
    if (codeConsumed) {
      throw error;
    }
    console.log(
      `Stored registration was not accepted (${
        error instanceof Error ? error.message : String(error)
      }); registering again.`
    );
    provider.invalidateCredentials('all');
    await authorize();
  } finally {
    server.close();
  }
};
