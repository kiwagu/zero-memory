import { describe, expect, it } from 'vitest';

import {
  cameThroughEdge,
  forwardedForFromEdge,
  VIEWER_HEADER,
} from './lambda.config.js';

describe('forwardedForFromEdge', () => {
  it("replaces a client's own X-Forwarded-For with the address the edge saw", () => {
    const headers: Record<string, string | undefined> = {
      'x-forwarded-for': '198.51.100.7, 203.0.113.9',
      [VIEWER_HEADER]: '203.0.113.9',
    };
    forwardedForFromEdge(headers);
    expect(headers).toEqual({ 'x-forwarded-for': '203.0.113.9' });
  });

  it('drops X-Forwarded-For when the edge named no address', () => {
    const headers: Record<string, string | undefined> = {
      'x-forwarded-for': '198.51.100.7',
    };
    forwardedForFromEdge(headers);
    expect(headers).toEqual({});
  });
});

describe('cameThroughEdge', () => {
  it('passes everything when no edge is configured', () => {
    expect(cameThroughEdge(undefined, undefined)).toBe(true);
  });

  it('needs the exact shared value when one is', () => {
    expect(cameThroughEdge('secret', 'secret')).toBe(true);
    expect(cameThroughEdge('secreT', 'secret')).toBe(false);
    expect(cameThroughEdge('secret-longer', 'secret')).toBe(false);
    expect(cameThroughEdge(undefined, 'secret')).toBe(false);
  });
});
