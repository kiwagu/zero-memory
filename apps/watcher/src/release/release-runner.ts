import {
  compareVersions,
  type DeployedVersion,
  renderMissingTag,
  renderReleaseKnown,
  renderReleaseNotice,
  renderRollback,
  tagForVersion,
} from '@workspace/client-core';
import {
  callRelease,
  fetchDeployedVersion,
  projectIgnored,
  projectScopeStatePath,
  readProjectScope,
  readReleaseState,
  RELEASE_FETCH_EVERY_MS,
  RELEASE_RETRY_MS,
  RELEASE_SETTINGS_TTL_MS,
  releaseCheckStatePath,
  releaseHandledDue,
  writeReleaseState,
  type ReleaseCheckoutState,
} from '@workspace/client-runtime';
import { createLogger } from '@workspace/logger';

import { readGitFacts } from '../landing/git-facts.js';
import { resolveProjectHint } from '../project-hint-resolver.js';
import { isAncestorOf, latestTag, tagCommit } from './git-release.js';

const logger = createLogger('release');

/** Each network step's own deadline. */
export const RELEASE_LOOKUP_TIMEOUT_MS = 5000;
/**
 * The whole check's budget. After a command it rides in the landing hook's
 * process, whose slowest host (Hermes) allows 20 s for landing and release
 * together; at session start it shares the briefing's time.
 */
export const RELEASE_CHECK_BUDGET_MS = 8000;

/** Why a check has nothing to say: what a manual run prints in its place. */
type Quiet =
  | 'ignored'
  | 'no-project'
  | 'no-production'
  | 'no-server'
  | 'no-version'
  | 'not-a-checkout'
  | 'nothing-new';

type ReleaseCheck = { line: string } | { line: null; quiet: Quiet };

const QUIET_LINES: Record<Quiet, string> = {
  ignored:
    'release: this folder is ignored (.zero-memory-ignore); nothing was checked',
  'no-project': 'release: this folder is not a briefed project',
  'no-production': 'release: this project names no production state',
  'no-server': 'release: the server could not be asked — try again later',
  'no-version':
    "release: production's version could not be read (the version url did not answer with one)",
  'not-a-checkout': 'release: this folder is not a git checkout',
  'nothing-new': 'release: nothing new for this project',
};

interface ReleaseCheckOptions {
  now?: number;
  lookupTimeoutMs?: number;
  budgetMs?: number;
  /**
   * A manual run: the setting and the url are asked now, the state is tried
   * again whatever this checkout did with it before — so a card whose landing
   * was recorded after the release was is marked then — and a missing tag is
   * named every time.
   */
  force?: boolean;
}

/**
 * What production took since this machine last looked, as one line for the
 * session, or null when there is nothing new to say.
 *
 * The order keeps it cheap: almost every call resolves the project through
 * git (`rev-parse`, cached per process) and reads local files (the ignore
 * marker, the scope, the release state); a tag-mode project also lists its
 * tags; the setting and the url are asked at most every two minutes. The
 * project's setting names where production lives (a version url, else the
 * highest release among its tags); the state resolves to a commit through its tag in this
 * checkout; a card is carried when its latest landing here is an ancestor of
 * that commit; the release is recorded through the server and told once in
 * each checkout.
 * Never throws for a server or url that cannot answer: it stays quiet and
 * tries again later. A folder the user ignored is left alone.
 */
export const checkRelease = async (
  cwd: string,
  options: ReleaseCheckOptions = {}
): Promise<string | null> => (await inspectRelease(cwd, options)).line;

/** The check itself, with the reason it has nothing to say. */
const inspectRelease = async (
  cwd: string,
  options: ReleaseCheckOptions
): Promise<ReleaseCheck> => {
  const quiet = (why: Quiet): ReleaseCheck => ({ line: null, quiet: why });
  // The check writes to the server: a project the user ignored sends nothing.
  if (projectIgnored(cwd)) return quiet('ignored');
  const now = options.now ?? Date.now();
  const deadline = Date.now() + (options.budgetMs ?? RELEASE_CHECK_BUDGET_MS);
  const left = (): number =>
    Math.max(
      0,
      Math.min(
        options.lookupTimeoutMs ?? RELEASE_LOOKUP_TIMEOUT_MS,
        deadline - Date.now()
      )
    );

  const hint = resolveProjectHint(cwd);
  const scope = readProjectScope(projectScopeStatePath(), hint);
  if (!scope) return quiet('no-project');
  const path = releaseCheckStatePath();
  // What production runs is the project's; which cards it carries is each
  // checkout's own git, so what was handled is kept per checkout.
  const { checkouts, ...state } = readReleaseState(path, scope);
  const checkout: ReleaseCheckoutState = checkouts?.[hint] ?? {};
  const save = (): void =>
    writeReleaseState(path, scope, {
      ...state,
      checkouts: { [hint]: checkout },
    });

  // 1. The setting: cached, refreshed every ten minutes. The attempt is saved
  //    before asking, so a server that stalls is asked again only after the
  //    two-minute pause; meanwhile a stale value serves as it is.
  let settings = state.settings?.value ?? null;
  const stale =
    !state.settings ||
    now - state.settings.fetched_at >= RELEASE_SETTINGS_TTL_MS;
  const pausing =
    state.settings_attempt_at !== undefined &&
    now - state.settings_attempt_at < RELEASE_FETCH_EVERY_MS;
  if (options.force || (stale && !pausing)) {
    state.settings_attempt_at = now;
    save();
    try {
      settings =
        (await callRelease({ action: 'settings', scope }, left())).settings ??
        null;
    } catch {
      return quiet('no-server'); // asked again after the pause
    }
    state.settings = { value: settings, fetched_at: now };
    save();
  } else if (!state.settings) {
    return quiet('no-server'); // the last attempt failed and is still pausing
  }
  if (!settings) return quiet('no-production'); // no production: no trigger

  // 2. The current state: the url at most every two minutes while it answers,
  //    ten after it failed to, else the last version it answered; without a
  //    url, the highest release among its tags.
  let seen: DeployedVersion | null;
  let source: 'url' | 'tag';
  if (settings.version_url) {
    source = 'url';
    const pause =
      state.url_failed_at === undefined
        ? RELEASE_FETCH_EVERY_MS
        : RELEASE_RETRY_MS;
    if (
      options.force ||
      state.last_fetch_at === undefined ||
      now - state.last_fetch_at >= pause
    ) {
      state.last_fetch_at = now;
      save(); // throttled even when the url stalls
      const read = await fetchDeployedVersion(
        settings.version_url,
        settings.version_field,
        left()
      ).catch(() => null);
      // A url that did not answer says nothing about production: what it
      // said before is dropped, so no record rides on a stale reading.
      if (read) {
        state.seen = read;
        delete state.url_failed_at;
      } else {
        delete state.seen;
        state.url_failed_at = now;
      }
      save();
    }
    seen = state.seen ?? null;
    if (!seen) return quiet('no-version');
  } else {
    source = 'tag';
    // Without a url, the tag search runs straight on `cwd`: outside a git
    // checkout it silently finds nothing, which reads as "no tag yet" rather
    // than the actual reason — say so before it does.
    if (!readGitFacts(cwd)) return quiet('not-a-checkout');
    const latest = latestTag(cwd, settings.tag_pattern, settings.tag_template);
    seen = latest ? { version: latest.version, build: null } : null;
  }
  if (!seen) return quiet('nothing-new');
  // A state this checkout handled before, but not the one it last reported, is
  // a return to it — a rollback, or forward again after one: handle it afresh.
  if (checkout.current !== undefined && checkout.current !== seen.version) {
    const before = checkout.handled?.[seen.version]?.outcome;
    if (before === 'recorded' || before === 'rollback') {
      checkout.handled = Object.fromEntries(
        Object.entries(checkout.handled ?? {}).filter(
          ([version]) => version !== seen.version
        )
      );
    }
  }
  const previous = checkout.handled?.[seen.version]?.outcome;
  // A manual run tries the state again whatever came of it here: the store
  // offers only the cards with nothing released since their latest landing,
  // so a second record marks just what landed late, and nothing twice.
  const due = options.force || releaseHandledDue(checkout, seen.version, now);
  if (!due) return quiet('nothing-new');
  const current = seen;
  const mark = (
    outcome: 'recorded' | 'no-tag' | 'rollback' | 'error'
  ): void => {
    checkout.handled = {
      ...(checkout.handled ?? {}),
      [current.version]: { outcome, at: now },
    };
    // Only a state the session was told about becomes the one this checkout
    // reports; a missing tag or a failure is tried again as it stands.
    if (outcome === 'recorded' || outcome === 'rollback') {
      checkout.current = current.version;
    }
    save();
  };

  // 3. The state resolves to a commit through its tag, in this checkout.
  const facts = readGitFacts(cwd);
  if (!facts) return quiet('not-a-checkout');
  const tag = tagForVersion(settings.tag_template, current.version);
  const commit = tagCommit(facts.root, tag);
  if (!commit) {
    mark('no-tag');
    // Said once per version; a retry that still finds no tag stays quiet,
    // unless someone asked by hand.
    return previous === 'no-tag' && !options.force
      ? quiet('nothing-new')
      : { line: renderMissingTag(current.version, tag) };
  }

  // 4. A version below the newest one recorded here is a rollback: the state is
  //    kept, no card changes.
  const newest = Object.entries(checkout.handled ?? {})
    .filter(([, handled]) => handled.outcome === 'recorded')
    .map(([version]) => version)
    .sort(compareVersions)
    .at(-1);

  mark('error'); // failed until proven otherwise, like the landing check
  try {
    if (newest && compareVersions(current.version, newest) < 0) {
      await callRelease(
        {
          action: 'record',
          scope,
          version: current.version,
          build: current.build,
          release_commit: commit,
          source,
          card_ids: [],
        },
        left()
      );
      mark('rollback');
      return { line: renderRollback(current.version, newest) };
    }
    const { cards = [] } = await callRelease(
      { action: 'candidates', scope, version: current.version },
      left()
    );
    // Only a card's LATEST landing here decides: marked on an older one while
    // its follow-up is not yet released, the card would close before the
    // follow-up ships, and the release that ships it would never be recorded.
    const carried = cards.filter((card) => {
      const here = card.landings.filter(
        (landing) => landing.repo === facts.identity
      );
      const latest = here.at(-1);
      return (
        latest !== undefined &&
        isAncestorOf(facts.root, latest.squash_sha, commit)
      );
    });
    const result = await callRelease(
      {
        action: 'record',
        scope,
        version: current.version,
        build: current.build,
        release_commit: commit,
        source,
        card_ids: carried.map((c) => c.id),
        // The landing each card was checked at: one that lands again before
        // this record is skipped and waits for the release that ships it.
        landing_seqs: carried.map((c) => c.landing_seq),
      },
      left()
    );
    mark('recorded');
    const recorded = new Set(result.recorded ?? []);
    const moved = new Set(result.moved ?? []);
    const fresh = carried.filter((card) => recorded.has(card.id));
    if (fresh.length === 0 && result.release?.first_observed === false) {
      // Another session saw this state first and marked its cards.
      return { line: renderReleaseKnown(current.version, current.build) };
    }
    return {
      line: renderReleaseNotice({
        version: current.version,
        build: current.build,
        policy: settings.on_release,
        carried: fresh.map((c) => ({ number: c.number, state: c.state })),
        moved: fresh.filter((c) => moved.has(c.id)).map((c) => c.number),
      }),
    };
  } catch (error) {
    logger.info('release check failed; retrying later', {
      error: String(error),
    });
    return quiet('no-server');
  }
};

/**
 * `zero-memory-watcher release`: check this project now and print what was
 * found, or why there is nothing to say — the tool for recording a release
 * right after its missing tag was fetched or made.
 */
export const runRelease = async (
  cwd: string = process.cwd()
): Promise<void> => {
  const found = await inspectRelease(cwd, { force: true });
  process.stdout.write(`${found.line ?? QUIET_LINES[found.quiet]}\n`);
};
