import { describe, expect, it } from 'vitest';

import {
  PROJECT_HINT_UNRESOLVABLE,
  projectHintUnresolvableMessage,
  SCOPE_TARGET_REQUIRED,
  scopeTargetRequiredMessage,
  writeRefusalReasonOf,
} from './scope-target.schema.js';

describe('write refusal messages', () => {
  it('names every route out of a targetless write', () => {
    const message = scopeTargetRequiredMessage();

    // The refusal exists to make the retry deterministic — if a route is
    // missing from it, the agent has to guess, which is the failure mode the
    // refusal replaced.
    expect(message.startsWith(`${SCOPE_TARGET_REQUIRED}:`)).toBe(true);
    expect(message).toContain('project_hint');
    expect(message).toContain('"core"');
    expect(message).toContain('"personal"');
  });

  it('names the thread as a route, since a reconnect is the common cause', () => {
    const message = scopeTargetRequiredMessage();

    // The session record is reset by a reconnect while the conversation and
    // its project are unchanged — the token is what recovers that without the
    // agent having to re-derive a repo path.
    expect(message).toContain('thread');
  });

  it('states that the portable layers are checked, not simply granted', () => {
    const message = scopeTargetRequiredMessage();

    // The refusal is also where an agent learns the bar: core/personal are
    // for knowledge that holds outside the project, and the claim is verified.
    expect(message).toContain('OUTSIDE this project');
    expect(message).toContain('lands in the project instead');
  });

  it('reports an unroutable hint under its own code', () => {
    const message = projectHintUnresolvableMessage('/');

    expect(message.startsWith(`${PROJECT_HINT_UNRESOLVABLE}:`)).toBe(true);
    expect(message).toContain('"/"');
  });

  it('classifies refusals by prefix and nothing else', () => {
    expect(writeRefusalReasonOf(scopeTargetRequiredMessage())).toBe(
      SCOPE_TARGET_REQUIRED
    );
    expect(writeRefusalReasonOf(projectHintUnresolvableMessage('x'))).toBe(
      PROJECT_HINT_UNRESOLVABLE
    );
    // Prose that merely mentions a scope is not a refusal: the counter must
    // measure the contract, not the wording of unrelated failures.
    expect(writeRefusalReasonOf('scope target required, probably')).toBeNull();
    expect(writeRefusalReasonOf('Embedding service returned no vector.')).toBe(
      null
    );
  });
});
