import { describe, expect, it } from 'vitest';

import { healthUrlFrom } from './server-reachability';

describe('healthUrlFrom', () => {
  it('replaces the mcp endpoint suffix with the health path', () => {
    expect(healthUrlFrom('http://zm-server:8787/mcp')).toBe(
      'http://zm-server:8787/healthz'
    );
  });

  it('tolerates a trailing slash', () => {
    expect(healthUrlFrom('http://zm-server:8787/mcp/')).toBe(
      'http://zm-server:8787/healthz'
    );
  });

  it('appends to a bare origin', () => {
    expect(healthUrlFrom('https://api.example.com')).toBe(
      'https://api.example.com/healthz'
    );
  });
});
