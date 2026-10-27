/**
 * Whether this build ships a working SubQ Snap adapter. The dashboard reads it
 * through `@workspace/judgment/availability` to decide whether `subq` is
 * offered as a provider choice. This module imports nothing, so a consumer
 * can read the flag without loading the DI container or decorator metadata.
 */
export const SUBQ_ADAPTER_AVAILABLE = true;
