import { z } from 'zod';

import { serverSupabaseEnvironment } from './supabase/env';

/** The providers this dashboard knows how to draw, in display order. */
export const SOCIAL_PROVIDERS = ['github', 'google'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

const settingsSchema = z.object({
  external: z.record(z.string(), z.boolean()),
});

/**
 * Which social providers THIS Supabase instance has switched on.
 *
 * Read from Auth's public settings endpoint at render time, never from the
 * build: one published image serves instances with different providers, and
 * a button for a provider the instance does not have is a dead end. When the
 * endpoint cannot be read, the form shows no buttons — a login page without
 * them is still a login page, a login page that errors is not.
 */
export async function readEnabledProviders(
  env: { url: string; anonKey: string } = serverSupabaseEnvironment(),
  fetchImpl: typeof fetch = fetch
): Promise<SocialProvider[]> {
  try {
    const response = await fetchImpl(`${env.url}/auth/v1/settings`, {
      headers: { apikey: env.anonKey },
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`settings answered ${response.status}`);
    }
    const settings = settingsSchema.parse(await response.json());
    return SOCIAL_PROVIDERS.filter(
      (provider) => settings.external[provider] === true
    );
  } catch (error) {
    console.warn('auth providers unavailable; showing none', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
