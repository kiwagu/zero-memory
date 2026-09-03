import { spawn } from 'node:child_process';
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

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (error) {
      res.end(`<p>Authorization failed: ${error}. You can close this tab.</p>`);
      rejectCode(new Error(`authorization error: ${error}`));
      return;
    }
    if (!code) {
      res.end('<p>Missing authorization code. You can close this tab.</p>');
      rejectCode(new Error('callback carried no authorization code'));
      return;
    }
    res.end('<p>zero-memory authorized. You can close this tab.</p>');
    resolveCode(code);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const provider = new FileOAuthProvider({
    serverUrl,
    redirectUri,
    store,
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
