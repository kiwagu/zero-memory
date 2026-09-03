import type { ILlmGateway } from './llm-gateway.js';

/**
 * Nothing until the composition root installs one. A gateway decides whose
 * key to use and whether a budget allows the call — defaulting to some
 * unguarded stand-in would mean an unconfigured process quietly spends on the
 * platform key with no ceiling and no attribution.
 */
let current: ILlmGateway | null = null;

/**
 * The gateway in force for this process.
 *
 * Background jobs — the hygiene scanner, the ROI runner, the translation
 * worker — construct their collaborators themselves rather than resolving them
 * from the container, so there is no injection point to hand them a decorated
 * gateway through. Resolving it here, at the moment of the call, means a
 * decorator installed at boot covers those paths too.
 *
 * Call this per request rather than caching the result in a field: a class
 * built before the composition root ran would otherwise hold the undecorated
 * gateway for the rest of the process's life.
 */
export const llmGateway = (): ILlmGateway => {
  if (current === null) {
    throw new Error(
      'no LLM gateway installed — the composition root must call setLlmGateway'
    );
  }
  return current;
};

/**
 * Install the gateway every call goes through. Called once, from the
 * composition root, before any work starts.
 */
export const setLlmGateway = (gateway: ILlmGateway): void => {
  current = gateway;
};
