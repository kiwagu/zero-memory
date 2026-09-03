import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  OAuthClientInformationFullSchema,
  OAuthTokensSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';

/**
 * Persisted OAuth state for one MCP server (keyed by its URL). Holds the
 * dynamically-registered client, the token pair, and the transient PKCE
 * verifier used mid-login. `redirectUri` is captured at login time so runtime
 * (non-interactive) use can present the same value.
 */
export const oauthEntrySchema = z.object({
  redirectUri: z.string().optional(),
  clientInformation: OAuthClientInformationFullSchema.optional(),
  tokens: OAuthTokensSchema.optional(),
  codeVerifier: z.string().optional(),
});
export type OAuthEntry = z.infer<typeof oauthEntrySchema>;

/** The whole file: a map of server URL -> entry. */
export const oauthStateSchema = z.record(z.string(), oauthEntrySchema);
export type OAuthState = z.infer<typeof oauthStateSchema>;

/** ~/.local/state/zero-memory/oauth.json (XDG_STATE_HOME aware). */
export const defaultStatePath = (): string =>
  join(
    process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
    'zero-memory',
    'oauth.json'
  );

/**
 * File-backed OAuth state. Tokens are secrets, so the file is written 0600.
 * Reads never throw — a missing or corrupt file reads as empty state, so a
 * client simply behaves as "not logged in" rather than crashing.
 */
export class OAuthStateStore {
  constructor(private readonly path: string = defaultStatePath()) {}

  read(): OAuthState {
    try {
      const parsed = oauthStateSchema.safeParse(
        JSON.parse(readFileSync(this.path, 'utf8'))
      );
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  entry(key: string): OAuthEntry | undefined {
    return this.read()[key];
  }

  write(state: OAuthState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(state, null, 2), { mode: 0o600 });
  }

  /** Merge a patch into one server's entry (read-modify-write). */
  update(key: string, patch: Partial<OAuthEntry>): void {
    const state = this.read();
    state[key] = oauthEntrySchema.parse({ ...(state[key] ?? {}), ...patch });
    this.write(state);
  }

  /** Drop fields from one server's entry, or the whole entry with 'all'. */
  remove(key: string, fields: 'all' | Array<keyof OAuthEntry>): void {
    const state = this.read();
    if (!(key in state)) {
      return;
    }
    if (fields === 'all') {
      delete state[key];
    } else {
      const entry = { ...state[key] };
      for (const field of fields) {
        delete entry[field];
      }
      state[key] = entry;
    }
    this.write(state);
  }
}
