#!/usr/bin/env bun
/**
 * UserPromptSubmit hook example: on the FIRST substantive prompt of a
 * session, deliver the project's memory pack plus the one instruction that
 * makes the task-shaped lookup happen — the agent writes its own English
 * topic and calls build_context itself. The prompt decides only WHETHER the
 * briefing is worth spending; it is never sent as the topic, because a
 * request is not a search query and the server does not translate one.
 *
 * One task briefing per session: a state file keyed by session_id remembers
 * both the one-shot flag and which mem_ ids the SessionStart briefing already
 * injected, so nothing is delivered twice. Short prompts, confirmations, and
 * slash commands are skipped. Failures are silent (exit 0, no context) so a
 * down memory server never blocks the prompt.
 */
import { basename } from 'node:path';

import {
  filterBriefingPack,
  isEmptyPack,
  isSubstantivePrompt,
  parseBriefingPack,
  renderOpenLoopsSection,
  resolveAcknowledgementWords,
  splitOpenLoops,
} from '@workspace/client-core';
import {
  briefStatePath,
  loadBriefState,
  markTaskBriefed,
} from '@workspace/client-runtime';

import { callMcpTool, readHookEnv, readStdinJson } from './mcp-http-call.js';

const main = async (): Promise<void> => {
  const payload = await readStdinJson();
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  const sessionId =
    typeof payload.session_id === 'string' ? payload.session_id : '';
  if (
    !sessionId ||
    !isSubstantivePrompt(
      prompt,
      resolveAcknowledgementWords(process.env.ZM_ACK_WORDS)
    )
  ) {
    return;
  }

  const statePath = briefStatePath();
  const session = loadBriefState(statePath)[sessionId];
  if (session?.task_briefed) return;

  // The prompt never leaves the machine: it is human text in the user's own
  // language, and the server does not translate — sending it would search an
  // English corpus with whatever was typed. The topic is the project, and the
  // task-shaped lookup is left to the agent (see the instruction emitted
  // below). briefing_kind lets the server meter task briefings separately.
  const topic = basename(process.cwd());
  const pack = parseBriefingPack(
    await callMcpTool(readHookEnv(), 'build_context', {
      topic,
      max_tokens: 1200,
      briefing: true,
      briefing_kind: 'task',
    })
  );

  // The call succeeded — this session's one task briefing is spent, even if
  // dedup drains the pack below anything worth injecting.
  markTaskBriefed(statePath, sessionId);

  const filtered = filterBriefingPack(pack, session?.injected_ids ?? []);
  if (isEmptyPack(filtered)) return;

  // Loops the session-start briefing already showed are filtered out above;
  // anything left (opened since, or a missed session-start) renders as the
  // prominent section instead of hiding inside the JSON.
  const { payload: packPayload, loops, total } = splitOpenLoops(filtered);
  const loopSection = renderOpenLoopsSection(loops, total);
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: [
          // The one line this hook exists to deliver: the pack is the
          // project's, so the task-shaped lookup is the agent's to make.
          "The pack below is the PROJECT's, not this task's. Before working " +
            'on what was just asked, call build_context yourself with an ' +
            'English topic you write for it.',
          ...(loopSection ? [loopSection] : []),
          `Persistent memory briefing for "${topic}" ` +
            `(from the zero-memory server):\n${JSON.stringify(packPayload)}`,
        ].join('\n\n'),
      },
    })
  );
};

main().catch(() => {
  // Best-effort: a missing/down memory server must not block the prompt.
  process.exit(0);
});
