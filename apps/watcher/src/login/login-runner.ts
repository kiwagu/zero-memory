import {
  E2E_SERVER_URL,
  normalizeServerUrl,
  persistServerUrl,
  probeLiveness,
  resolveServerUrlOrNull,
  serverConfigPath,
  ServerNotConfiguredError,
  serverUrlOrigin,
} from '@workspace/client-runtime';
import { createLogger } from '@workspace/logger';
import { runLogin } from '@workspace/mcp-oauth-client';

const logger = createLogger('login');

export interface LoginArgs {
  /** Authorize against the disposable local e2e sandbox instead. */
  readonly e2e: boolean;
  /** The address to adopt, when one was given. */
  readonly url: string | null;
}

/** `login [<url>] [--e2e]` — the one positional is the server to adopt. */
export const parseLoginArgs = (argv: string[]): LoginArgs => ({
  e2e: argv.includes('--e2e'),
  url: argv.find((arg) => !arg.startsWith('-')) ?? null,
});

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

/**
 * Authorize this machine, and — when an address is given — ADOPT it: the URL is
 * checked for a live server and then persisted, so one command settles both
 * halves that used to be set separately (and could therefore disagree). Every
 * outcome names the server, because "logged in" without saying where is the
 * report that let a machine authorize against the wrong instance unnoticed.
 */
export const runWatcherLogin = async (argv: string[]): Promise<void> => {
  const { e2e, url } = parseLoginArgs(argv);

  // The sandbox is a fixed, disposable stack: authorize against it (tokens are
  // stored per URL, so this never touches the real server's credentials) but
  // never make it this machine's persisted answer.
  if (e2e) {
    process.stdout.write(
      `Authorizing against the e2e sandbox ${E2E_SERVER_URL}\n`
    );
    await runLogin(E2E_SERVER_URL);
    return;
  }

  if (url) {
    let target: string;
    try {
      target = normalizeServerUrl(url);
    } catch {
      return void fail(`zero-memory: "${url}" is not a valid URL.`);
    }
    const live = await probeLiveness(target);
    if (live.state !== 'ok') {
      return void fail(
        `zero-memory: no server answered at ${target} (${live.detail}). ` +
          'Nothing was stored — check the address and that the server is up.'
      );
    }
    persistServerUrl(target);
    process.stdout.write(
      `Server ${target} stored in ${serverConfigPath()} — this machine's ` +
        'clients (hooks, ingest, editor registration) all read it from there.\n'
    );
    await runLogin(target);
    logger.info('authorized', { serverUrl: target, adopted: true });
    return;
  }

  const current = resolveServerUrlOrNull();
  if (!current) {
    return void fail(new ServerNotConfiguredError().message);
  }
  process.stdout.write(
    `Authorizing against ${current} (from ${
      serverUrlOrigin() === 'env' ? 'ZM_SERVER_URL' : serverConfigPath()
    })\n`
  );
  await runLogin(current);
  logger.info('authorized', { serverUrl: current, adopted: false });
};
