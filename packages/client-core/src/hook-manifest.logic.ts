/**
 * The watcher's hook set, declared ONCE for every channel that wires it.
 *
 * Two channels wire the same subcommands into a coding agent: a plugin ships its
 * own `hooks.json`, and a machine that runs no plugin gets the hooks written
 * into the agent's settings file by an installer script. Those two used to
 * declare the set independently, and they drifted — with a failure mode far
 * worse than a broken build: four features existed only on the plugin side, so
 * on a machine deliberately running no plugin they never fired for weeks and
 * nothing anywhere said so. Gates prove the code works; they cannot prove the
 * channel is wired. Declaring the set here lets every channel render from one
 * source and lets the binary report what is actually wired on the machine.
 *
 * Pure data plus string helpers: no IO, so the installer script, the wiring
 * check and the tests all read the same declaration.
 */

/**
 * Which channel a hook set is rendered for.
 *
 * - `plugin` — a plugin's own hook manifest. It deliberately omits transcript
 *   capture: capture belongs in the user's own settings file, where it is
 *   visible and removable, not inside a plugin cache the user never edits.
 * - `ingest` — the capture hooks a plugin-equipped machine still needs in its
 *   settings file, for exactly that reason. Membership is decided by one
 *   question — does this hook ship transcript content off the machine — so the
 *   compaction boundary belongs here too, even though it also delivers.
 * - `full` — every hook, for a machine that runs no plugin at all and therefore
 *   has no other channel.
 */
export type HookProfile = 'plugin' | 'ingest' | 'full';

export interface HookEntry {
  /** The client event this hook is wired to. */
  readonly event: string;
  /** Tool matcher, for the events that take one. */
  readonly matcher?: string;
  /** The watcher subcommand and its arguments, e.g. `brief session-start`. */
  readonly command: string;
  /** Seconds — set only where the round trip needs more than the client default. */
  readonly timeout?: number;
}

/** The binary name, and the substring that identifies one of our hooks. */
export const WATCHER_BIN_NAME = 'zero-memory-watcher';

const BRIEF_SESSION: HookEntry = {
  event: 'SessionStart',
  command: 'brief session-start',
};
const BRIEF_TASK: HookEntry = {
  event: 'UserPromptSubmit',
  command: 'brief task',
};
const STATUS: HookEntry = { event: 'UserPromptSubmit', command: 'status' };
/** The server round trip needs more than the default hook timeout. */
const RECEIPT: HookEntry = {
  event: 'SessionEnd',
  command: 'receipt',
  timeout: 10,
};
const INGEST: HookEntry = { event: 'Stop', command: 'ingest' };

/**
 * The compaction boundary — the one joint where a conversation keeps its id but
 * loses the context it was reasoning from.
 *
 * It captures (the epoch about to be compacted away) and delivers (an anchor to
 * the model writing the summary) in one firing, because both are only possible
 * at that instant and spawning the binary twice would buy nothing. Capture is
 * what decides where it is wired: it ships transcript content, so it goes where
 * the user can see and remove it. Like the receipt, its server round trip needs
 * more than the default hook timeout.
 */
const CHECKPOINT: HookEntry = {
  event: 'PreCompact',
  command: 'checkpoint',
  timeout: 10,
};

/**
 * The memory-first mandate as an injected hook.
 *
 * Only the plugin channel needs it. A plugin cannot patch the agent's global
 * instruction file, so injecting the mandate per session is the strongest lever
 * it has. The settings channel installs the mandate as an always-on rule in that
 * file instead, which is strictly stronger — so wiring this there too would just
 * deliver the same text a second time.
 */
const GUIDE: HookEntry = { event: 'SessionStart', command: 'guide' };

/**
 * The four wirings of the recall-gap reminder, which is one concern with one
 * per-session counter behind it — the runner dispatches on the firing event.
 *
 * `PostToolUse` on the memory tools is the only way to know whether a session
 * has consulted memory at all; everything else is gated on that count being
 * zero, which is what keeps the reminder from becoming noise. The two reminder
 * triggers are deliberately different in kind: a failed investigation tool is
 * the moment a stored gotcha would have helped, and end-of-turn is the moment a
 * session that wrote without ever reading can still be told so.
 *
 * The failure trigger is the one measured to change behaviour, and it is cheap
 * precisely because tool failures are rare — a per-search trigger would spawn
 * the binary on ordinary work for the same reminder.
 */
const RECALL_TRACK: HookEntry = {
  event: 'PostToolUse',
  matcher: 'mcp__zero-memory__.*',
  command: 'nudge',
};
const RECALL_ON_FAILURE: HookEntry = {
  event: 'PostToolUseFailure',
  matcher: 'Bash|Grep|Glob|Read|Edit|Write',
  command: 'nudge',
};
const RECALL_ON_TURN_END: HookEntry = { event: 'Stop', command: 'nudge' };
/** The original search-time reminder, kept for the channel that already ships it. */
const RECALL_ON_SEARCH: HookEntry = {
  event: 'PreToolUse',
  matcher: 'Grep|Glob',
  command: 'nudge',
};

const PROFILES: Record<HookProfile, readonly HookEntry[]> = {
  plugin: [
    BRIEF_SESSION,
    GUIDE,
    BRIEF_TASK,
    STATUS,
    RECEIPT,
    RECALL_ON_SEARCH,
    RECALL_TRACK,
    RECALL_ON_FAILURE,
    RECALL_ON_TURN_END,
  ],
  ingest: [INGEST, CHECKPOINT],
  full: [
    BRIEF_SESSION,
    BRIEF_TASK,
    STATUS,
    RECEIPT,
    INGEST,
    CHECKPOINT,
    RECALL_ON_SEARCH,
    RECALL_TRACK,
    RECALL_ON_FAILURE,
    RECALL_ON_TURN_END,
  ],
};

/** The hook entries a channel should carry. */
export const hookManifest = (profile: HookProfile): readonly HookEntry[] =>
  PROFILES[profile];

/**
 * The substring that identifies an entry's hook in a settings file, regardless
 * of how its command spells the binary — an absolute path, a `~`-relative one or
 * a bare name all contain it. Matching on this is what makes re-wiring
 * idempotent instead of appending a second copy of the same hook.
 */
export const hookIdentity = (entry: HookEntry): string =>
  `${WATCHER_BIN_NAME} ${entry.command}`;

/**
 * The command to run, with the binary spelled exactly as the caller asked.
 *
 * The spelling is the CALLER's choice, between two safe forms — and one unsafe
 * one to avoid. Agents run hook commands through a shell, so an absolute path
 * depends on nothing and a `~`-relative one depends only on tilde expansion;
 * both hold even where the hook subprocess inherits a stripped PATH. A BARE name
 * does not: it needs the directory on that PATH, and where it is missing the hook
 * still registers and fires but exits 127 silently — no log, no effect. So
 * callers pick absolute (settings file stays on one machine) or `~`-relative
 * (file travels to another user), never bare.
 */
export const hookCommand = (entry: HookEntry, binPath: string): string =>
  `${binPath} ${entry.command}`;
