import {
  isLandingRecorded,
  renderLandingReminder,
  type LandingDrift,
} from '@workspace/client-core';
import {
  callCardBranches,
  landingCheckDue,
  landingCheckStatePath,
  projectScopeStatePath,
  readProjectScope,
  recordLandingCheck,
} from '@workspace/client-runtime';
import type { BriefingWork } from '@workspace/contracts';
import { createLogger } from '@workspace/logger';

import { hookClient, type HookClient } from '../hook-client.js';
import { resolveProjectHint } from '../project-hint-resolver.js';
import { findLanding, readGitFacts, recentSquashes } from './git-facts.js';

const logger = createLogger('landing');

/** How far back a squash is looked for: a release commit may sit on top. */
const LOOKBACK_COMMITS = 8;
/** A squash older than this is the briefing's to notice, not this hook's. */
const FRESH_HOURS = 12;
/** Open branches a briefing checks against git, at most. */
const DRIFT_BRANCHES = 10;

/**
 * `landing` — the check that runs right after a shell command.
 *
 * It looks at the last few commits of the repository the command ran in. A
 * squash whose trailer names a board card (`ZM-N`, or the earlier `#N`) and
 * that this machine has not checked yet is looked up on the board; if the
 * card has no record of that landing, one line tells the agent exactly what
 * to record. Everything else — an ordinary commit, a repository with no
 * briefed project, a squash already checked — ends after one git read.
 *
 * It reads commits rather than the command that ran, so a squash made by a
 * script is caught and a command that merely mentions a trailer is not.
 * Never throws: a hook must not break the session it observes.
 */
export const runLanding = async (
  adapter: HookClient = hookClient()
): Promise<void> => {
  try {
    const input = await adapter.readInput();
    const facts = readGitFacts(input.cwd);
    if (!facts || facts.head === null) return;

    const statePath = landingCheckStatePath();
    const due = recentSquashes(facts.root, LOOKBACK_COMMITS, FRESH_HOURS)
      .flatMap(({ sha, trailers }) =>
        trailers.flatMap((trailer) =>
          trailer.cards.map((number) => ({
            key: `${sha}#${number}`,
            sha,
            branch: trailer.branch,
            number,
          }))
        )
      )
      .filter((item) => landingCheckDue(statePath, item.key));
    if (due.length === 0) return;

    const scope = readProjectScope(
      projectScopeStatePath(),
      resolveProjectHint(input.cwd)
    );
    if (!scope) {
      logger.info('landing check skipped: no briefed project here', {
        root: facts.root,
      });
      return;
    }

    const reminders: string[] = [];
    for (const item of due) {
      try {
        const found = await callCardBranches(scope, item.number);
        if (!found.card) {
          recordLandingCheck(statePath, item.key, 'no-card');
          continue;
        }
        if (
          isLandingRecorded(
            found.branches,
            facts.identity,
            item.branch,
            item.sha
          )
        ) {
          recordLandingCheck(statePath, item.key, 'recorded');
          continue;
        }
        // Marked BEFORE the line is emitted: a reminder nobody saw costs less
        // than one that repeats on every command.
        recordLandingCheck(statePath, item.key, 'reminded');
        reminders.push(
          renderLandingReminder({
            cardId: found.card.id,
            cardNumber: item.number,
            repo: facts.identity,
            branch: item.branch,
            squashSha: item.sha,
            target: facts.head,
          })
        );
      } catch (error) {
        recordLandingCheck(statePath, item.key, 'error');
        logger.warn('landing check could not ask the board', {
          error: String(error),
        });
      }
    }

    if (reminders.length > 0) {
      const event =
        input.hookEventName ||
        (adapter.kind === 'cursor' ? 'postToolUse' : 'PostToolUse');
      adapter.emitTurnContext(event, reminders.join('\n'));
      logger.info('landing reminder emitted', {
        count: reminders.length,
        client: adapter.kind,
      });
    }
  } catch (error) {
    logger.warn('landing hook error (ignored)', { error: String(error) });
  }
};

/**
 * The briefing's half: open branches of THIS repository whose squash a local
 * branch already carries. Catches what the hook could not — a landing made
 * in another session, another client, or before the plugin was installed.
 * A targeted search per known branch, bounded, never the whole history.
 */
export const landingDriftFor = (
  cwd: string,
  work: BriefingWork
): LandingDrift[] => {
  const open = work.open_branches ?? [];
  if (open.length === 0) return [];
  const facts = readGitFacts(cwd);
  if (!facts) return [];
  const drift: LandingDrift[] = [];
  for (const branch of open
    .filter((item) => item.repo === facts.identity)
    .slice(0, DRIFT_BRANCHES)) {
    const landing = findLanding(facts.root, branch.branch);
    if (landing) {
      drift.push({
        cardId: branch.card_id,
        cardNumber: branch.number,
        state: branch.state,
        repo: branch.repo,
        branch: branch.branch,
        squashSha: landing.sha,
        target: landing.target,
      });
    }
  }
  return drift;
};
