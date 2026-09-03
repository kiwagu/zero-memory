#!/usr/bin/env bun
/**
 * SessionStart hook example: unfolds the memory context for the project the
 * session starts in and injects it as additional context.
 *
 * It briefs on TWO topics when possible: the project (basename of cwd) for the
 * broad picture, and the current git branch when it is a feature branch, so a
 * session that starts on feature/ui-extractor-settings gets the memories that
 * decided that specific work — not just the generic project briefing.
 *
 * Wire-up (see docs/getting-started/claude-code.mdx): register as a SessionStart
 * hook; it reads the hook payload on stdin, calls the build_context tool on
 * the MCP server, and prints the hookSpecificOutput JSON expected by the
 * hook protocol. Failures are silent (exit 0, no context) so a down memory
 * server never blocks a session.
 */
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

import {
  mergeOpenLoops,
  packMemoryIds,
  renderOpenLoopsSection,
  splitOpenLoops,
} from '@workspace/client-core';
import {
  briefStatePath,
  recordSessionBriefing,
} from '@workspace/client-runtime';

import { callMcpTool, readHookEnv, readStdinJson } from './mcp-http-call.js';

/**
 * The current branch as a semantic topic, or null when it is not worth a second
 * lookup (detached HEAD, or a trunk branch whose briefing == the project one).
 * `feature/ui-extractor-settings` -> `ui extractor settings`.
 */
const branchTopic = (cwd: string): string | null => {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!branch || branch === 'HEAD') return null;
    if (['main', 'dev', 'stage', 'master'].includes(branch)) return null;
    const topic = branch
      .replace(/^feature\//, '')
      .replace(/[-/]+/g, ' ')
      .trim();
    return topic.length > 0 ? topic : null;
  } catch {
    return null;
  }
};

const main = async (): Promise<void> => {
  const payload = await readStdinJson();
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  const env = readHookEnv();
  const project = basename(cwd);
  const branch = branchTopic(cwd);

  // Both best-effort and independent: a failing branch lookup must not sink the
  // project briefing, so each settles on its own.
  // briefing: true marks these as the session-start briefing so the server
  // meters them as session_briefing events — the fuel for the
  // value dashboard's briefing hit-rate and saved-tokens. Ignored by older
  // servers (the input field is optional and stripped).
  const [projectBriefing, branchBriefing] = await Promise.all([
    callMcpTool(env, 'build_context', {
      topic: project,
      max_tokens: 1200,
      briefing: true,
    })
      .then((briefing) => ({ topic: project, briefing }))
      .catch(() => null),
    branch
      ? callMcpTool(env, 'build_context', {
          topic: branch,
          max_tokens: 1200,
          briefing: true,
        })
          .then((briefing) => ({ topic: branch, briefing }))
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const delivered = [projectBriefing, branchBriefing].filter(
    (section): section is NonNullable<typeof section> => section !== null
  );

  // Open loops render as ONE prominent section (both briefings cover the
  // same scopes, so their loops are merged, not repeated) and are drained
  // from the JSON dumps below.
  const splits = delivered.map((section) => ({
    topic: section.topic,
    split: splitOpenLoops(section.briefing),
  }));
  const merged = mergeOpenLoops(splits.map((section) => section.split));
  const loopSection = renderOpenLoopsSection(merged.loops, merged.total);
  const sections = [
    ...(loopSection ? [loopSection] : []),
    ...splits.map(
      (section) =>
        `Persistent memory briefing for "${section.topic}" ` +
        `(from the zero-memory server):\n${JSON.stringify(section.split.payload)}`
    ),
  ];

  // Record which mem_ ids this briefing injected, so the task briefing on
  // the first substantive prompt can skip them. Best-effort: state problems
  // must not sink the briefing itself.
  const sessionId =
    typeof payload.session_id === 'string' ? payload.session_id : '';
  if (sessionId) {
    try {
      recordSessionBriefing(
        briefStatePath(),
        sessionId,
        delivered.flatMap((section) => packMemoryIds(section.briefing))
      );
    } catch {
      // ignore: dedup degrades gracefully, the briefing still ships.
    }
  }

  // Nothing to say (server down, or no memories on either topic): stay silent.
  if (sections.length === 0) return;

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: sections.join('\n\n'),
      },
    })
  );
};

main().catch(() => {
  // Best-effort: a missing/down memory server must not break session start.
  process.exit(0);
});
