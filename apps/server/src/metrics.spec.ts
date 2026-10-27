import { describe, expect, it } from 'vitest';

import { incrementCounter, renderMetrics } from './metrics.js';

// Counters live for the process lifetime, so each test owns its own metric
// name rather than resetting shared state between tests.
describe('metrics', () => {
  it('accumulates a labelled counter across increments', () => {
    incrementCounter('http_requests_total', { status: '200' });
    incrementCounter('http_requests_total', { status: '200' });
    incrementCounter('http_requests_total', { status: '500' });

    const out = renderMetrics();
    expect(out).toContain('# TYPE http_requests_total counter');
    expect(out).toContain('http_requests_total{status="200"} 2');
    expect(out).toContain('http_requests_total{status="500"} 1');
  });

  it('renders an unlabelled counter without braces', () => {
    incrementCounter('http_errors_total');
    expect(renderMetrics()).toContain('http_errors_total 1');
  });

  it('escapes special characters in label values', () => {
    incrementCounter('mcp_tool_calls_total', { tool: 'we"ird' });
    expect(renderMetrics()).toContain('tool="we\\"ird"');
  });
});
