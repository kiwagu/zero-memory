import { describe, expect, it } from 'vitest';

import { E2E_SERVER_URL } from './server-config.js';

describe('ingest client endpoints', () => {
  it('exposes the disposable e2e sandbox endpoint', () => {
    expect(E2E_SERVER_URL).toBe('http://localhost:8788/mcp');
  });
});
