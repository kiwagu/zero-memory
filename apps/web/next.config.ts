import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources.
  transpilePackages: [
    '@workspace/db',
    '@workspace/i18n-catalogs',
    '@workspace/ui',
  ],
  // Reaching a dev server from another machine goes through a LAN alias, and
  // Next blocks cross-origin dev-resource requests unless the host is
  // allowlisted. `zm.local` is one such alias (mDNS on the maintainer's
  // network); add your own here — it affects `next dev` only.
  allowedDevOrigins: ['zm.local'],
  // Next locks its dist directory, and refuses to start a second dev server for
  // the same project directory ("Another next dev server is already running").
  // Two local stands do legitimately serve this same working tree at once, so
  // the second one points here at a directory of its own. Unset everywhere
  // else — dev, CI and the production build keep writing `.next`.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // The floating dev-tools badge photobombs the corner of every documentation
  // screenshot (the e2e stands run `next dev`), so the stands turn it off.
  // Ordinary development keeps it — it affects `next dev` only.
  ...(process.env.ZM_DEV_INDICATORS === 'off'
    ? { devIndicators: false as const }
    : {}),
  // Self-contained server bundle for the production container image.
  output: 'standalone',
  // Trace files from the monorepo root so workspace deps are included.
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), '../..'),
  // Baseline security headers on every response: no MIME sniffing, no
  // referrer leakage of app URLs, no framing (clickjacking).
  headers: async () => [
    {
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
      ],
    },
  ],
};

export default nextConfig;
