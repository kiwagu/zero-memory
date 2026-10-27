import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  RuleCandidateQueue,
  type RuleCandidateItem,
  type RuleCandidateQueueLabels,
} from '@workspace/ui/components/rules/rule-candidate-queue';

const labels: RuleCandidateQueueLabels = {
  empty: 'No candidates.',
  confidence: 'Confidence {value}',
  evidence: 'Fired usefully in {sessions} sessions',
  evidenceFirst: 'first {date}',
  evidenceLast: 'last {date}',
  sourceMemory: 'Source memory',
  target: { user: 'General', project: 'Project' },
  targetHint: { user: 'Paste it globally.', project: 'Paste it here.' },
  actions: {
    promote: 'Approve',
    dismiss: 'Dismiss',
    snooze: 'Snooze',
    delete: 'Delete',
  },
  copy: 'Copy',
  copied: 'Copied',
  download: 'Download',
  revoke: 'Revoke',
  promotedBadge: 'Promoted',
  dismissedBadge: 'dismissed',
  appliesTo: 'Applies to:',
  addressTo: 'Load in',
  addressHint: 'General rules load everywhere.',
  pin: 'Always deliver',
  pinHint: 'Pinned rules are never dropped.',
  pinnedBadge: 'pinned',
  carriedFrom: 'moved from',
  appliesWhen: {
    label: 'Applies when',
    placeholder: 'Observable task features',
    missing: 'No applicability yet',
  },
  enforcedBy: { label: 'Enforced by guard', placeholder: 'guard name' },
  stats: {
    title: 'Delivery over the last 30 days',
    line: '{calls} calls · full {full} · gate {gate} · headline {headline} · mean p {meanP} · fetched after headline {fetches}',
  },
};

const promoted = (
  overrides: Partial<RuleCandidateItem> = {}
): RuleCandidateItem => ({
  id: 'rlc_one',
  status: 'promoted',
  ruleText: 'Write one-line commit messages.',
  targetLayer: 'user',
  confidence: null,
  rationale: null,
  usefulSessions: 4,
  firstUsed: null,
  lastUsed: null,
  memory: { id: 'mem_one', kind: 'convention', scope: 'user.u', href: '#' },
  scopes: [],
  ...overrides,
});

const render = (item: RuleCandidateItem) =>
  renderToStaticMarkup(
    <RuleCandidateQueue
      items={[item]}
      labels={labels}
      pendingId={null}
      error={null}
      onResolve={() => undefined}
      onRevoke={() => undefined}
      onAppliesWhen={() => undefined}
      onEnforcedBy={() => undefined}
    />
  );

describe('RuleCandidateQueue delivery fields', () => {
  it('fills the stats line of a promoted rule from its counts', () => {
    const html = render(
      promoted({
        stats: {
          calls: 12,
          full: 5,
          gate: 4,
          headline: 3,
          meanP: 0.5126,
          fetches: 2,
        },
      })
    );
    expect(html).toContain('data-testid="rule-stats"');
    expect(html).toContain(
      '12 calls · full 5 · gate 4 · headline 3 · mean p 0.51 · fetched after headline 2'
    );
  });

  it('shows a dash for a mean that was never measured, and nothing without stats', () => {
    const unmeasured = render(
      promoted({
        stats: {
          calls: 1,
          full: 0,
          gate: 0,
          headline: 1,
          meanP: null,
          fetches: 0,
        },
      })
    );
    expect(unmeasured).toContain('mean p —');
    expect(render(promoted({ stats: null }))).not.toContain(
      'data-testid="rule-stats"'
    );
  });
});
