import { formatCardLabel } from '@workspace/contracts';

/** What a production url answered: the version, and the build after `+`. */
export interface DeployedVersion {
  version: string;
  build: string | null;
}

const VERSION =
  /^v?([0-9A-Za-z][0-9A-Za-z._-]{0,63})(?:\+([0-9A-Za-z._-]{1,64}))?$/u;

const fieldOf = (body: unknown, field: string): unknown =>
  field
    .split('.')
    .reduce<unknown>(
      (value, key) =>
        value !== null && typeof value === 'object'
          ? (value as Record<string, unknown>)[key]
          : undefined,
      body
    );

/**
 * The version a production url reports, or null when there is none to trust:
 * the field is missing, is not a string, or is not shaped like a version. A
 * leading `v` is dropped so the version matches a tag template's `{version}`.
 */
export const parseDeployedVersion = (
  body: unknown,
  field: string
): DeployedVersion | null => {
  const raw = fieldOf(body, field);
  if (typeof raw !== 'string') return null;
  const match = VERSION.exec(raw.trim());
  if (!match?.[1]) return null;
  return { version: match[1], build: match[2] ?? null };
};

/**
 * The rule the store puts on a project's version url, checked again before a
 * watcher reads one: https, or http on this machine only, and no credentials.
 */
export const isReleaseUrl = (url: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.protocol === 'https:') return true;
  return (
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  );
};

export const tagForVersion = (template: string, version: string): string =>
  template.replace('{version}', version);

export const versionFromTag = (
  template: string,
  tag: string
): string | null => {
  const [prefix = '', suffix = ''] = template.split('{version}');
  if (!tag.startsWith(prefix) || !tag.endsWith(suffix)) return null;
  const version = tag.slice(prefix.length, tag.length - suffix.length);
  return VERSION.test(version) ? version : null;
};

/** Numeric by dotted part; a pre-release sorts before its release. */
export const compareVersions = (a: string, b: string): number => {
  const [coreA = '', preA] = a.split('-', 2);
  const [coreB = '', preB] = b.split('-', 2);
  const partsA = coreA.split('.');
  const partsB = coreB.split('.');
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i += 1) {
    const x = Number(partsA[i] ?? 0);
    const y = Number(partsB[i] ?? 0);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      const byText = (partsA[i] ?? '').localeCompare(partsB[i] ?? '');
      if (byText !== 0) return byText;
    } else if (x !== y) {
      return x - y;
    }
  }
  if (preA === undefined && preB !== undefined) return 1;
  if (preA !== undefined && preB === undefined) return -1;
  return (preA ?? '').localeCompare(preB ?? '');
};

export interface CarriedCard {
  number: number;
  state: string;
}

/**
 * The one line a session gets when production took changes. It names the
 * cards someone still has to act on — waiting ones, and those the policy
 * moved; the rest are counted, so a first run over a long history stays one
 * line.
 */
export const renderReleaseNotice = (p: {
  version: string;
  build: string | null;
  carried: CarriedCard[];
  moved: number[];
  policy: 'record' | 'record_and_move_done';
}): string => {
  const at = `v${p.version}${p.build ? ` (build ${p.build})` : ''}`;
  if (p.carried.length === 0) {
    return `PRODUCTION IS AT ${at}: no card on the board carries a landing in it.`;
  }
  const named = p.carried.filter(
    (card) => card.state === 'waiting' || p.moved.includes(card.number)
  );
  const others = p.carried.length - named.length;
  const list = [
    ...named.map((card) => formatCardLabel(card.number)),
    ...(others > 0 ? [`${others} more card${others === 1 ? '' : 's'}`] : []),
  ].join(', ');
  const moved =
    p.moved.length > 0
      ? ` The policy moved ${p.moved.map(formatCardLabel).join(', ')} to done.`
      : '';
  const waiting = named
    .filter((card) => !p.moved.includes(card.number))
    .map((card) => formatCardLabel(card.number));
  const rest =
    waiting.length > 0
      ? ` ${waiting.join(', ')} stay waiting until the owner accepts them live — then move them to done with the released version.`
      : '';
  return `PRODUCTION TOOK THE CHANGES: ${at} carries ${list}; the release is recorded on each.${moved}${rest}`;
};

export const renderMissingTag = (version: string, tag: string): string =>
  `PRODUCTION IS AT v${version}, but tag ${tag} is not in this repository, so the cards it carries cannot be told: \`git fetch --tags\`, or tag the release commit ${tag}.`;

export const renderRollback = (version: string, previous: string): string =>
  `PRODUCTION WENT back to v${version} (from v${previous}); no card was changed.`;

/** Another session saw this state first and already marked the cards it carries. */
export const renderReleaseKnown = (
  version: string,
  build: string | null
): string =>
  `PRODUCTION IS AT v${version}${build ? ` (build ${build})` : ''}; its release is already recorded on the cards it carries.`;
