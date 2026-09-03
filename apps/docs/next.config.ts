import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources.
  transpilePackages: ['@workspace/ui'],
  // Reaching a dev server from another machine goes through a LAN alias, and
  // Next blocks cross-origin dev-resource requests unless the host is
  // allowlisted. `zm.local` is one such alias (mDNS on the maintainer's
  // network); add your own here — it affects `next dev` only.
  allowedDevOrigins: ['zm.local'],
  // Self-contained server bundle for the production container image.
  output: 'standalone',
  // Trace files from the monorepo root: the content tree lives outside this
  // app, and workspace deps must be included in the bundle.
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), '../..'),
  outputFileTracingIncludes: {
    '/docs/**': ['../../docs/**/*'],
  },
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

export default createMDX()(nextConfig);
