import { describe, expect, it } from 'vitest';

import {
  readBrowserSupabaseConfig,
  serverSupabaseEnvironment,
  supabaseAuthCookieName,
} from './env';

describe('serverSupabaseEnvironment', () => {
  it('prefers the internal runtime URL and key', () => {
    expect(
      serverSupabaseEnvironment({
        SUPABASE_URL: 'http://supabase-kong:8000',
        SUPABASE_ANON_KEY: 'internal-key',
        NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.example.com',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-key',
      })
    ).toEqual({
      url: 'http://supabase-kong:8000',
      anonKey: 'internal-key',
      authCookieName: 'sb-supabase-auth-token',
    });
  });

  it('falls back to public values for local development', () => {
    expect(
      serverSupabaseEnvironment({
        NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:55321',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'dev-key',
      })
    ).toEqual({
      url: 'http://127.0.0.1:55321',
      anonKey: 'dev-key',
      authCookieName: 'sb-127-auth-token',
    });
  });

  it('fails clearly when the public URL is not configured', () => {
    expect(() =>
      serverSupabaseEnvironment({
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'dev-key',
      })
    ).toThrow('NEXT_PUBLIC_SUPABASE_URL');
  });

  it('derives the same auth cookie namespace as supabase-js', () => {
    expect(supabaseAuthCookieName('https://project-ref.supabase.co')).toBe(
      'sb-project-ref-auth-token'
    );
  });
});

describe('browser config handed through the document', () => {
  const stubDoc = (text: string | null) => ({
    getElementById: () => (text === null ? null : { textContent: text }),
  });

  it('prefers what the server injected over build-time values', () => {
    expect(
      readBrowserSupabaseConfig(
        stubDoc(
          JSON.stringify({ url: 'https://runtime.example.com', anonKey: 'run' })
        ) as unknown as Document,
        {
          NEXT_PUBLIC_SUPABASE_URL: 'https://baked.example.com',
          NEXT_PUBLIC_SUPABASE_ANON_KEY: 'baked',
        }
      )
    ).toEqual({ url: 'https://runtime.example.com', anonKey: 'run' });
  });

  it('falls back to build-time values when nothing was injected', () => {
    expect(
      readBrowserSupabaseConfig(stubDoc(null) as unknown as Document, {
        NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:55321',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'dev-key',
      })
    ).toEqual({ url: 'http://127.0.0.1:55321', anonKey: 'dev-key' });
  });

  it('ignores a half-written payload rather than booting a broken client', () => {
    expect(
      readBrowserSupabaseConfig(
        stubDoc(
          JSON.stringify({ url: 'https://partial.example.com' })
        ) as unknown as Document,
        {
          NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:55321',
          NEXT_PUBLIC_SUPABASE_ANON_KEY: 'dev-key',
        }
      )
    ).toEqual({ url: 'http://127.0.0.1:55321', anonKey: 'dev-key' });
  });

  it('refuses to guess when neither source has values', () => {
    expect(() =>
      readBrowserSupabaseConfig(stubDoc(null) as unknown as Document, {})
    ).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});
