/**
 * The dashboard's session cookie, written the way its cookie library writes
 * it, so a test can present an arbitrary Auth session — one the authorization
 * server opened for an agent, say — to the dashboard as a browser would.
 */
import type { Session } from '@supabase/supabase-js';

import { e2eEnv } from './env.js';

/** The library splits a long value into cookies of at most this many chars. */
const MAX_CHUNK_SIZE = 3180;

/** The cookie's name, derived from the Auth URL as the dashboard derives it. */
export const dashboardCookieName = (): string =>
  `sb-${new URL(e2eEnv.supabaseUrl).hostname.split('.')[0]}-auth-token`;

export interface DashboardCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Lax';
}

/**
 * The cookie, or chunked cookies, carrying this session: the JSON of the
 * session, base64url-encoded behind a `base64-` marker, split into chunks
 * named `<name>.0`, `<name>.1`, … when it does not fit one cookie. The
 * encoding uses no character that URL-escaping would expand, so chunk
 * boundaries fall on plain character counts.
 */
export const dashboardSessionCookies = (
  session: Session,
  webUrl = e2eEnv.webUrl
): DashboardCookie[] => {
  const name = dashboardCookieName();
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;
  const shape = {
    domain: new URL(webUrl).hostname,
    path: '/',
    httpOnly: false,
    secure: false,
    sameSite: 'Lax' as const,
  };
  if (value.length <= MAX_CHUNK_SIZE) {
    return [{ name, value, ...shape }];
  }
  const cookies: DashboardCookie[] = [];
  for (let index = 0; index * MAX_CHUNK_SIZE < value.length; index += 1) {
    cookies.push({
      name: `${name}.${index}`,
      value: value.slice(index * MAX_CHUNK_SIZE, (index + 1) * MAX_CHUNK_SIZE),
      ...shape,
    });
  }
  return cookies;
};
