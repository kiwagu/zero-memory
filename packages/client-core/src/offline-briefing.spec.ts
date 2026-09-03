import { describe, expect, it } from 'vitest';

import { DAY_MS, renderOfflineBriefing } from './offline-briefing.js';

const CWD = '/home/dev/repos/quokka-tool';

describe('offline briefing', () => {
  it('renders the offline frame with an explicit staleness header', () => {
    const rendered = renderOfflineBriefing(
      { cwd: CWD, context: 'cached body', cached_at: 0 },
      2 * DAY_MS
    );
    expect(rendered).toContain('OFFLINE briefing');
    expect(rendered).toContain('2d ago');
    expect(rendered).toContain('1970-01-01T00:00:00.000Z');
    expect(rendered.endsWith('cached body')).toBe(true);
  });
});
