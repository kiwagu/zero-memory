import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';

import {
  ClientBundleDownload,
  ClientBundleInstall,
} from '@/components/client-bundle-download';
import {
  HostedConnectCommand,
  HostedDashboardLink,
  HostedMcpEndpoint,
} from '@/components/hosted-instance';
import { Screenshot } from '@/components/screenshot';

/**
 * Pages must render with these: the defaults map `img` onto the component that
 * understands a build-time image import. Rendering MDX without them stringifies
 * the import into `[object Object]` for a `src`.
 *
 * The two client-bundle components are here so a page can state the download
 * and its install commands WITHOUT hardcoding an address: both read the build's
 * environment (see `lib/client-bundle.ts`), which is what lets the archive move
 * between hosts without touching the prose.
 */
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    ClientBundleDownload,
    ClientBundleInstall,
    HostedConnectCommand,
    HostedDashboardLink,
    HostedMcpEndpoint,
    Screenshot,
    ...components,
  };
}
