import { formatCardLabel, type CardState } from '@workspace/contracts';

/**
 * Landing: the moment a branch's work lands on its target as one squash
 * commit. The board records it (`card land`); this module is the pure half of
 * noticing when nobody did — reading squash trailers out of commit messages,
 * naming a repository the way the board names it, and the lines a hook or a
 * briefing says about a landing that is not on record. No IO here: the
 * watcher reads git and the server, and hands the facts in.
 */

/** One `Squashed-from:` trailer: the branch, its tip, and the cards it names. */
export interface SquashTrailer {
  branch: string;
  tipSha: string;
  cards: number[];
}

// Anchored to a whole line, so a trailer quoted inside prose never counts.
const TRAILER =
  /^Squashed-from:[ \t]+(\S+)[ \t]+\(([0-9a-f]{7,40})\)((?:[ \t]+(?:ZM-\d+|#\d+))*)[ \t]*$/gmu;

/**
 * Every squash trailer in a commit message. Cards are named `ZM-N`, the form
 * that no forge turns into a link; the earlier `#N` still parses, because
 * commits that carry it are already published and are never rewritten.
 */
export const parseSquashTrailers = (message: string): SquashTrailer[] =>
  [...message.matchAll(TRAILER)].map((match) => ({
    branch: match[1]!,
    tipSha: match[2]!,
    cards: [...(match[3] ?? '').matchAll(/(?:ZM-|#)(\d+)/gu)].map((card) =>
      Number(card[1])
    ),
  }));

/**
 * The repository as the board names it: `owner/name` — the last two path
 * segments of a remote url in any form git accepts (scp-like, ssh://,
 * https://, a local path), with a trailing `.git` or `/` dropped. Null when
 * the url has fewer than two segments to name it by; the caller then falls
 * back to the repository's folder name.
 */
export const repoIdentityFromRemote = (url: string): string | null => {
  const trimmed = url
    .trim()
    .replace(/\/+$/u, '')
    .replace(/\.git$/u, '');
  if (trimmed === '') return null;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/iu;
  const path = scheme.test(trimmed)
    ? trimmed.replace(scheme, '')
    : !trimmed.startsWith('/') && trimmed.includes(':')
      ? trimmed.slice(trimmed.indexOf(':') + 1)
      : trimmed;
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const identity = segments.slice(-2).join('/');
  return /^[^\s:]{1,200}$/u.test(identity) ? identity : null;
};

/** A literal for a git `-E --grep` pattern: branch names carry `.` and `+`. */
export const escapeGitRegex = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const sameCommit = (left: string, right: string): boolean => {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
};

/**
 * Whether the board already holds this landing: the branch landed, in this
 * repository, as this commit — a short sha and a full one are the same
 * commit either way round.
 */
export const isLandingRecorded = (
  branches: ReadonlyArray<{
    repo: string;
    branch: string;
    state: string;
    squash_sha: string | null;
  }>,
  repo: string,
  branch: string,
  sha: string
): boolean =>
  branches.some(
    (item) =>
      item.repo === repo &&
      item.branch === branch &&
      item.state === 'landed' &&
      item.squash_sha !== null &&
      sameCommit(item.squash_sha, sha)
  );

/** A landing git shows: which card, which branch, which commit, where. */
export interface LandingFacts {
  cardId: string;
  cardNumber: number;
  repo: string;
  branch: string;
  squashSha: string;
  target: string;
}

/** A landing git shows while the card still holds the branch open. */
export interface LandingDrift extends LandingFacts {
  state: CardState;
}

const short = (sha: string): string => sha.slice(0, 7).toLowerCase();

/**
 * The one line a hook says right after a squash the board has not heard of.
 * It carries the exact call, values filled in, so recording it costs the
 * agent nothing but the reason only it can write.
 */
export const renderLandingReminder = (facts: LandingFacts): string => {
  const call = JSON.stringify({
    action: 'land',
    card_id: facts.cardId,
    branch: { repo: facts.repo, name: facts.branch },
    squash_sha: short(facts.squashSha),
    target: facts.target,
    to: 'waiting',
    reason: '<what the gate proved and what the card waits for>',
  });
  return (
    `LANDING NOT RECORDED: commit ${short(facts.squashSha)} on ${facts.target} ` +
    `squashes ${facts.branch} for card ${formatCardLabel(facts.cardNumber)}, ` +
    'and the card has ' +
    `no record of it. Record it now with the card tool: ${call} ` +
    '(use to: "done" when no acceptance is pending).'
  );
};

/** A briefing line for a landing the card does not know about. */
export const renderLandingDrift = (drift: LandingDrift): string =>
  `- ${formatCardLabel(drift.cardNumber)} [${drift.state}]: branch ` +
  `${drift.branch} landed as ` +
  `${short(drift.squashSha)} on ${drift.target}, but the card still holds it ` +
  `open — record it with \`card land\` (card_id ${drift.cardId}, branch ` +
  `{repo: ${drift.repo}, name: ${drift.branch}}, squash_sha ` +
  `${short(drift.squashSha)}, target ${drift.target}).`;
