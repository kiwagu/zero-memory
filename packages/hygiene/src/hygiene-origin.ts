/**
 * Cross-project pair filtering moved to `@workspace/contracts` so both the
 * hygiene scanner (post-write) and remember()'s supersede-candidate feedback
 * (write-time) share one predicate. Re-exported here to keep the scanner's
 * existing import path stable.
 */
export { crossProjectPair, type OriginSide } from '@workspace/contracts';
