import { createEntityId } from 'entity-id';
import { describe, expect, it } from 'vitest';

import { newRequestId, requestIdSchema } from './request-id.schema.js';

describe('requestIdSchema', () => {
  it('accepts a freshly minted request id', () => {
    const id = newRequestId();
    expect(requestIdSchema.parse(id)).toBe(id);
    expect(id.startsWith('req_')).toBe(true);
  });

  it('rejects an id carrying a different prefix', () => {
    expect(requestIdSchema.safeParse(createEntityId('mem')).success).toBe(
      false
    );
  });

  it('rejects an arbitrary client-supplied string', () => {
    expect(requestIdSchema.safeParse('whatever-the-client-sent').success).toBe(
      false
    );
    expect(requestIdSchema.safeParse('').success).toBe(false);
  });
});
