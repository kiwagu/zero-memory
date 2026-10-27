import { describe, expect, it } from 'vitest';

import { instanceMetricsSchema } from './instance-metrics.schema.js';

describe('instance-metrics registry', () => {
  // The content-free invariant, tested rather than intended: no key on the
  // operator surface may carry or reconstruct memory content. `top_facts` is
  // the one the per-user export carries and the operator surface must not.
  it('holds no content-bearing key', () => {
    const keys = Object.keys(instanceMetricsSchema.shape);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).not.toContain('top_facts');
    expect(keys).not.toContain('content');
  });
});
