import pkg from '../package.json';

/**
 * Human-readable identity of the running build: `v<semver>+<commit8>`,
 * e.g. `v0.2.0+12345678`. The values are baked into the image at build
 * time (ZM_BUILD_VERSION = the release tag, ZM_BUILD_COMMIT = the built
 * commit — see the Dockerfiles and the images CI job); outside an image
 * build they fall back to the package version and `dev`.
 */
export const buildVersion = (): string => {
  const raw = process.env.ZM_BUILD_VERSION || pkg.version;
  const version = raw.startsWith('v') ? raw : `v${raw}`;
  const commit = (process.env.ZM_BUILD_COMMIT || 'dev').slice(0, 8);
  return `${version}+${commit}`;
};
