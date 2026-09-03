export {
  briefStatePath,
  loadBriefState,
  markRulesDelivered,
  markTaskBriefed,
  MAX_TRACKED_SESSIONS,
  readSessionThread,
  recordSessionBriefing,
  recordSessionThread,
  stampSessionStart,
  type BriefStateFile,
  type SessionBriefState,
} from './task-brief.state.js';
export {
  countMemoryTool,
  loadRecallGapState,
  markRecallGapReminded,
  readRecallGapCounters,
  recallGapStatePath,
  type RecallGapSession,
  type RecallGapStateFile,
} from './recall-gap.state.js';
export {
  claimReceipt,
  loadReceiptState,
  MAX_TRACKED_RECEIPTS,
  receiptStatePath,
  recordCapturedMemories,
  type ReceiptStateFile,
  type SessionReceiptState,
} from './session-receipt.state.js';
export {
  briefCacheDir,
  briefCacheFile,
  clearBriefCache,
  readBriefCache,
  writeBriefCache,
} from './brief-cache.js';
export {
  defaultStatePath,
  OffsetState,
  type WatcherStateData,
} from './offset-state.js';

// Which server this machine talks to: one persisted answer (the config file),
// with the env var as a deliberate override and no invented default.
export {
  configuredServerUrl,
  E2E_SERVER_URL,
  normalizeServerUrl,
  persistServerUrl,
  resolveServerUrl,
  resolveServerUrlOrNull,
  serverConfigPath,
  ServerNotConfiguredError,
  SERVER_URL_ENV,
  serverUrlOrigin,
} from './server-config.js';

// MCP-transport port: every authed call the client makes to the server.
export { IngestClient } from './ingest-client.js';
export { callBuildContext } from './brief-client.js';
export {
  probeLiveness,
  probeServer,
  healthzUrlOf,
  type ServerState,
  type ServerProbe,
} from './server-probe.js';
export { callSessionReceipt } from './receipt-client.js';
export { callRemember } from './capture-client.js';
export { ImportClient } from './import-client.js';

// Ingest consent: the per-project gate every client path (Stop/stop hook AND
// the watch daemon) shares, so `.zero-memory-ignore` / ingest.json decide
// uniformly no matter which client or mode ships the transcript.
export {
  ingestAllowed,
  ingestMode,
  projectIgnored,
  type IngestMode,
} from './project-consent.js';

// Project-scope persistence: the client half of the project handshake — the
// server-resolved scope per repo root, carried across sessions.
export {
  projectScopeStatePath,
  readProjectScope,
  recordProjectScope,
} from './project-scope.state.js';
