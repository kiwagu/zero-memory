import pkg from '../package.json' with { type: 'json' };

/**
 * Build identity `v<semver>+<commit8>` surfaced by /healthz so operators
 * and the external verify script can see which build actually serves.
 * ZM_BUILD_VERSION/ZM_BUILD_COMMIT are baked in at image build (see the
 * Dockerfile and the images CI job); outside an image the fallbacks are
 * the package version and `dev`.
 */
export const buildVersion = (): string => {
  const raw = process.env.ZM_BUILD_VERSION || pkg.version;
  const version = raw.startsWith('v') ? raw : `v${raw}`;
  const commit = (process.env.ZM_BUILD_COMMIT || 'dev').slice(0, 8);
  return `${version}+${commit}`;
};

/**
 * The deployment checkout this container was started from, when the deploy
 * script passed it. A host carries TWO independent identities — the image it
 * runs and the checkout its compose files and scripts come from — and they
 * advance separately: a config-only change reaches the host by pulling the
 * checkout, without ever rebuilding an image. Reporting only the image hides
 * that drift, so an operator debugging a deployment cannot tell which
 * topology is actually in force.
 */
export const checkoutRevision = (): string | undefined =>
  process.env.ZM_CHECKOUT_SHA || undefined;
