interface SupabaseEnvironment {
  [name: string]: string | undefined;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
}

export function supabaseAuthCookieName(publicUrl: string): string {
  const hostname = new URL(publicUrl).hostname;
  return `sb-${hostname.split('.')[0]}-auth-token`;
}

/** Element id carrying the browser-facing Supabase config in the document. */
export const BROWSER_CONFIG_ELEMENT_ID = 'zm-browser-config';

export interface BrowserSupabaseConfig {
  url: string;
  anonKey: string;
}

/**
 * Browser-facing Supabase config, resolved on the SERVER and shipped inside the
 * document.
 *
 * Next inlines `NEXT_PUBLIC_*` at BUILD time, which would bake one deployment's
 * Supabase URL and key into the image and make a published image useless to
 * anyone else — every operator would have to rebuild. Resolving it per request
 * and handing it to the browser through the document keeps ONE image good for
 * any deployment. Nothing secret is exposed: both values are public by
 * definition and are what the browser bundle carried before.
 */
export function browserSupabaseConfig(
  env: SupabaseEnvironment = process.env
): BrowserSupabaseConfig {
  return {
    url: required(env.NEXT_PUBLIC_SUPABASE_URL, 'NEXT_PUBLIC_SUPABASE_URL'),
    anonKey: required(
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      'NEXT_PUBLIC_SUPABASE_ANON_KEY'
    ),
  };
}

/**
 * Read the config the server put in the document. Falls back to the build-time
 * values so `next dev` and the unit suite keep working without the injection.
 */
export function readBrowserSupabaseConfig(
  doc: Pick<Document, 'getElementById'>,
  env: SupabaseEnvironment
): BrowserSupabaseConfig {
  const raw = doc.getElementById(BROWSER_CONFIG_ELEMENT_ID)?.textContent;
  if (raw) {
    const parsed = JSON.parse(raw) as Partial<BrowserSupabaseConfig>;
    if (parsed.url && parsed.anonKey) {
      return { url: parsed.url, anonKey: parsed.anonKey };
    }
  }
  return browserSupabaseConfig(env);
}

function required(value: string | undefined, names: string): string {
  if (!value) {
    throw new Error(`Missing Supabase environment: set ${names}.`);
  }
  return value;
}

/**
 * Resolve Supabase for code that runs inside the Next server container.
 *
 * Production uses split-horizon URLs: browser code needs the external TLS
 * gateway, while server components/proxy/admin should use the Docker-network
 * URL and avoid DNS hairpinning. Local dev keeps the NEXT_PUBLIC fallback.
 */
export function serverSupabaseEnvironment(
  env: SupabaseEnvironment = process.env
): { url: string; anonKey: string; authCookieName: string } {
  const publicUrl = required(
    env.NEXT_PUBLIC_SUPABASE_URL,
    'NEXT_PUBLIC_SUPABASE_URL'
  );

  return {
    url: required(
      env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL,
      'SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL'
    ),
    anonKey: required(
      env.SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      'SUPABASE_ANON_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY'
    ),
    authCookieName: supabaseAuthCookieName(publicUrl),
  };
}
