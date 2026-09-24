import {
  compareVersions,
  type DeployedVersion,
  renderMissingTag,
  renderReleaseKnown,
  renderReleaseNotice,
  renderRollback,
  tagForVersion,
  versionFromTag,
} from '@workspace/client-core';
import {
  callRelease,
  fetchDeployedVersion,
  projectScopeStatePath,
  readProjectScope,
  readReleaseState,
  RELEASE_FETCH_EVERY_MS,
  RELEASE_SETTINGS_TTL_MS,
  releaseCheckStatePath,
  releaseHandledDue,
  writeReleaseState,
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

/**
 * What production took since this machine last looked, as one line for the
 * session, or null when there is nothing new to say.
 *
 * The order keeps it cheap: almost every call reads two state files and asks
 * neither git nor the network. The project's setting names where production
 * lives (a version url, else its newest release tag); the state resolves to a
 * commit through its tag in this checkout; a card is carried when its latest
 * landing here is an ancestor of that commit; the release is recorded through
 * the server and told once. Never throws for a server or url that cannot
 * answer: it stays quiet and tries again later.
 */
export const checkRelease = async (
  cwd: string,
  options: {
    now?: number;
    lookupTimeoutMs?: number;
    budgetMs?: number;
    force?: boolean;
  } = {}
): Promise<string | null> => {
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

  const scope = readProjectScope(
    projectScopeStatePath(),
    resolveProjectHint(cwd)
  );
  if (!scope) return null;
  const path = releaseCheckStatePath();
  const state = readReleaseState(path, scope);
  const save = (): void => writeReleaseState(path, scope, state);

  // 1. The setting: cached, refreshed every ten minutes.
  let settings = state.settings?.value ?? null;
  if (
    options.force ||
    !state.settings ||
    now - state.settings.fetched_at >= RELEASE_SETTINGS_TTL_MS
  ) {
    try {
      settings =
        (await callRelease({ action: 'settings', scope }, left())).settings ??
        null;
    } catch {
      return null; // server down: nothing to say; the next command asks again
    }
    state.settings = { value: settings, fetched_at: now };
    save();
  }
  if (!settings) return null; // the project names no production: no trigger

  // 2. The current state: the url at most every two minutes, else the last one
  //    seen; without a url, the newest release tag.
  let seen: DeployedVersion | null;
  let source: 'url' | 'tag';
  if (settings.version_url) {
    source = 'url';
    seen = state.seen ?? null;
    if (
      options.force ||
      !state.last_fetch_at ||
      now - state.last_fetch_at >= RELEASE_FETCH_EVERY_MS
    ) {
      state.last_fetch_at = now;
      save(); // throttled even when the url fails
      seen = await fetchDeployedVersion(
        settings.version_url,
        settings.version_field,
        left()
      ).catch(() => null);
      if (!seen) return null;
      state.seen = seen;
      save();
    }
  } else {
    source = 'tag';
    const tag = latestTag(cwd, settings.tag_pattern);
    const version = tag ? versionFromTag(settings.tag_template, tag) : null;
    seen = version ? { version, build: null } : null;
  }
  if (!seen) return null;
  // A state this machine handled before, but not the one it last reported, is
  // a return to it — a rollback, or forward again after one: handle it afresh.
  if (state.current !== undefined && state.current !== seen.version) {
    const before = state.handled?.[seen.version]?.outcome;
    if (before === 'recorded' || before === 'rollback') {
      state.handled = Object.fromEntries(
        Object.entries(state.handled ?? {}).filter(
          ([version]) => version !== seen.version
        )
      );
    }
  }
  if (!releaseHandledDue(state, seen.version, now)) return null;
  const current = seen;
  const previous = state.handled?.[current.version]?.outcome;
  const mark = (
    outcome: 'recorded' | 'no-tag' | 'rollback' | 'error'
  ): void => {
    state.handled = {
      ...(state.handled ?? {}),
      [current.version]: { outcome, at: now },
    };
    // Only a state the session was told about becomes the one this machine
    // reports; a missing tag or a failure is tried again as it stands.
    if (outcome === 'recorded' || outcome === 'rollback') {
      state.current = current.version;
    }
    save();
  };

  // 3. The state resolves to a commit through its tag, in this checkout.
  const facts = readGitFacts(cwd);
  if (!facts) return null;
  const tag = tagForVersion(settings.tag_template, current.version);
  const commit = tagCommit(facts.root, tag);
  if (!commit) {
    mark('no-tag');
    // Said once per version; a retry that still finds no tag stays quiet.
    return previous === 'no-tag'
      ? null
      : renderMissingTag(current.version, tag);
  }

  // 4. A version below the newest one recorded here is a rollback: the state is
  //    kept, no card changes.
  const newest = Object.entries(state.handled ?? {})
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
      return renderRollback(current.version, newest);
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
      },
      left()
    );
    mark('recorded');
    const recorded = new Set(result.recorded ?? []);
    const moved = new Set(result.moved ?? []);
    const fresh = carried.filter((card) => recorded.has(card.id));
    if (fresh.length === 0 && result.release?.first_observed === false) {
      // Another session saw this state first and marked its cards.
      return renderReleaseKnown(current.version, current.build);
    }
    return renderReleaseNotice({
      version: current.version,
      build: current.build,
      policy: settings.on_release,
      carried: fresh.map((c) => ({ number: c.number, state: c.state })),
      moved: fresh.filter((c) => moved.has(c.id)).map((c) => c.number),
    });
  } catch (error) {
    logger.info('release check failed; retrying later', {
      error: String(error),
    });
    return null;
  }
};

/** `zero-memory-watcher release`: check this project now and print what was found. */
export const runRelease = async (
  cwd: string = process.cwd()
): Promise<void> => {
  const line = await checkRelease(cwd, { force: true });
  process.stdout.write(`${line ?? 'release: nothing new for this project'}\n`);
};
