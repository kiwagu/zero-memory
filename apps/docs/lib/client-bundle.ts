import { z } from 'zod';

/**
 * WHERE THE CLIENT BUNDLE IS DOWNLOADED FROM — resolved once, at BUILD time,
 * and rendered into the install page.
 *
 * The archive's home is not a property of the documentation: it may sit on a
 * release page today and behind a CDN or an object store tomorrow. Writing the
 * address into the prose would make every move a documentation edit (and leave
 * older builds pointing at a dead file), so the page asks this module instead
 * and the build supplies the answer:
 *
 *   ZM_CLIENT_BUNDLE_URL      the archive (…zip) this build links to — an
 *                             absolute URL, or `/files/<name>.zip` served by
 *                             this site from `public/`
 *   ZM_CLIENT_BUNDLE_VERSION  optional label shown next to the link
 *
 * A build with no address is a legitimate state — a preview, a fork, a
 * documentation-only build — so the page renders the build-from-source path
 * instead of a broken link. Nothing here invents a fallback URL: a download
 * button that silently points at the wrong file is worse than an honest note.
 */

const isAbsoluteHttp = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

/** A service's address is always absolute — it names another host. */
const absoluteUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isAbsoluteHttp, 'Must be an http(s) URL');

/**
 * The archive may also be served by THIS site — `/files/<name>.zip`, read from
 * `public/`. That is the state before it has a home of its own: no host to name
 * yet, and a site-relative path keeps working when the site moves. Rejected:
 * a bare relative path (ambiguous once the page moves to another URL depth),
 * `//host/…` (an absolute URL wearing a relative coat) and any `..` traversal.
 */
const isSiteRelative = (value: string): boolean =>
  value.startsWith('/') && !value.startsWith('//') && !value.includes('..');

const bundleLocationSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => isAbsoluteHttp(value) || isSiteRelative(value),
    'Bundle location must be an http(s) URL or a site-root path (/files/…)'
  );

const bundleVersionSchema = z.string().trim().min(1).max(40);

export interface ClientBundle {
  /**
   * Where the archive is downloaded from — an absolute URL, or a path this
   * site serves itself. Null when the build publishes none.
   */
  readonly url: string | null;
  /** Release label to show beside the link, when the build named one. */
  readonly version: string | null;
  /** File name the download lands as (derived from the URL). */
  readonly fileName: string;
  /**
   * The folder the archive unpacks into. The archive holds one top-level
   * directory named like itself, so the commands can `cd` into it — a reader
   * who unzips into the current folder would otherwise scatter files.
   */
  readonly dirName: string;
  /**
   * True when the archive is served by this site (`/files/…`). Such a location
   * cannot be handed to `curl` — a reader clicks the button instead — so the
   * install commands start after the download.
   */
  readonly servedBySite: boolean;
}

const fileNameOf = (location: string): string => {
  const path = isAbsoluteHttp(location) ? new URL(location).pathname : location;
  const last = path.split('/').filter(Boolean).pop();
  return last && /\.(zip|tar\.gz|tgz)$/.test(last) ? last : 'zm-bundle.zip';
};

const dirNameOf = (fileName: string): string =>
  fileName.replace(/\.(zip|tar\.gz|tgz)$/, '');

/** What a reader of this module accepts: any environment-shaped map, so a
 * test can pass one without borrowing the process's own. */
type Env = Record<string, string | undefined>;

/** The download this build offers. Reads the environment, never a default. */
export const clientBundle = (env: Env = process.env): ClientBundle => {
  const url = bundleLocationSchema.safeParse(env.ZM_CLIENT_BUNDLE_URL);
  const version = bundleVersionSchema.safeParse(env.ZM_CLIENT_BUNDLE_VERSION);
  const fileName = url.success ? fileNameOf(url.data) : 'zm-bundle.zip';
  return {
    url: url.success ? url.data : null,
    version: version.success ? version.data : null,
    fileName,
    dirName: dirNameOf(fileName),
    servedBySite: url.success && !isAbsoluteHttp(url.data),
  };
};

/**
 * The hosted instance the documentation points a reader at. Same reasoning as
 * the bundle: the address of a service is deployment data, not prose. It does
 * carry a default, because unlike the archive it is a long-lived, published
 * endpoint — and a reader following the page must have something to connect to.
 */
export const hostedMcpUrl = (env: Env = process.env): string => {
  const parsed = absoluteUrlSchema.safeParse(env.ZM_HOSTED_MCP_URL);
  return parsed.success ? parsed.data : 'https://api.zero-memory.com/mcp';
};

/** The dashboard that goes with `hostedMcpUrl` (sign-up, memories, rules). */
export const hostedDashboardUrl = (env: Env = process.env): string => {
  const parsed = absoluteUrlSchema.safeParse(env.ZM_HOSTED_WEB_URL);
  return parsed.success ? parsed.data : 'https://app.zero-memory.com';
};
