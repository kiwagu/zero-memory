/**
 * In-process metrics: monotonic counters with optional labels, rendered in the
 * Prometheus text exposition format for `GET /metrics`. Deliberately
 * dependency-free — no OpenTelemetry — because structured logs plus a handful
 * of counters cover the current scale. Counters live for the process lifetime;
 * a scrape reads the running totals.
 */

export type Labels = Record<string, string>;

interface Series {
  labels: Labels;
  value: number;
}

/** Help text per metric name; absent names still render with a TYPE line. */
const HELP: Record<string, string> = {
  http_requests_total: 'Total HTTP requests handled, by response status.',
  http_errors_total: 'HTTP requests that ended in an unhandled error.',
  mcp_tool_calls_total: 'MCP tool invocations, by tool name.',
  promoted_rules_lookup_failures_total:
    'Promoted-rules lookups that failed at MCP session creation — the ' +
    'session fell back to base instructions (fail-open, invisible to the ' +
    'client), so a non-flat series here means owners are silently losing ' +
    'their network-served rules.',
};

const metrics = new Map<string, Map<string, Series>>();

const labelKey = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');

/** Increment a counter series by one, creating it on first use. */
export const incrementCounter = (name: string, labels: Labels = {}): void => {
  const series = metrics.get(name) ?? new Map<string, Series>();
  const key = labelKey(labels);
  const existing = series.get(key);
  series.set(key, { labels, value: (existing?.value ?? 0) + 1 });
  metrics.set(name, series);
};

const escapeLabelValue = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

const renderLabels = (labels: Labels): string => {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) {
    return '';
  }
  const inner = keys
    .map((k) => `${k}="${escapeLabelValue(labels[k] ?? '')}"`)
    .join(',');
  return `{${inner}}`;
};

/** Render all counters in Prometheus text format (empty string if none). */
export const renderMetrics = (): string => {
  const lines: string[] = [];
  for (const [name, series] of metrics) {
    const help = HELP[name];
    if (help) {
      lines.push(`# HELP ${name} ${help}`);
    }
    lines.push(`# TYPE ${name} counter`);
    for (const { labels, value } of series.values()) {
      lines.push(`${name}${renderLabels(labels)} ${value}`);
    }
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
};

/** Test-only: clear every counter. */
export const resetMetrics = (): void => {
  metrics.clear();
};
