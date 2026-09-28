import type { IContext } from '@workspace/context';
import { None, Ok } from 'oxide.ts';
import { describe, expect, it, vi } from 'vitest';

import type { MemoryService } from './memory.service.js';
import type { IProjectBindingRepository } from './project-binding.repository.js';
import type { ProjectCandidate } from './project-name.utils.js';
import { ProjectTargetService } from './project-target.service.js';
import type { IScopeAccessService } from './scope-access.service.js';
import { ScopeRoutingService } from './scope-routing.service.js';
import { Scope } from './scope.vo.js';

const OWNER = 'usr_owner00000000.0000000000';

const context = {
  mustGetCurrentUserEntityId: () => OWNER,
} as unknown as IContext;

const zeroMemory: ProjectCandidate = {
  scope: Scope.project(OWNER, 'zero_memory'),
  alias: null,
  own: true,
};
const harbor: ProjectCandidate = {
  scope: Scope.project(OWNER, 'harbor'),
  alias: null,
  own: true,
};

const makeTarget = (sessionProject?: string) => {
  const bindings: IProjectBindingRepository = {
    findScope: vi.fn().mockResolvedValue(None),
    insert: vi.fn().mockResolvedValue(Ok(undefined)),
  };
  const scopeAccess: IScopeAccessService = {
    canWrite: vi.fn().mockResolvedValue(false),
    createScope: vi.fn().mockResolvedValue(Ok(undefined)),
    listMemberProjects: vi.fn().mockResolvedValue(Ok([zeroMemory, harbor])),
  };
  const memory = {
    sessionProjectScope: vi.fn().mockResolvedValue(sessionProject),
  } as unknown as MemoryService;
  return {
    target: new ProjectTargetService(
      new ScopeRoutingService(bindings, scopeAccess, context),
      memory
    ),
    memory,
    scopeAccess,
  };
};

describe('ProjectTargetService.resolveBoard', () => {
  it('takes an explicit scope as given', async () => {
    const { target, memory } = makeTarget(harbor.scope.path);
    const board = await target.resolveBoard({
      scope: zeroMemory.scope.path,
      projectHint: 'harbor',
      sessionDefault: true,
    });
    expect(board.unwrap()).toBe(zeroMemory.scope.path);
    expect(memory.sessionProjectScope).not.toHaveBeenCalled();
  });

  it("goes to the session's project when nothing names a board", async () => {
    const { target, memory } = makeTarget(harbor.scope.path);
    const board = await target.resolveBoard({
      thread: 'thr_x',
      sessionDefault: true,
    });
    expect(board.unwrap()).toBe(harbor.scope.path);
    expect(memory.sessionProjectScope).toHaveBeenCalledWith('thr_x');
  });

  it('names no board for a read that named none', async () => {
    const { target, memory } = makeTarget(harbor.scope.path);
    const board = await target.resolveBoard({ sessionDefault: false });
    expect(board.unwrap()).toBeNull();
    expect(memory.sessionProjectScope).not.toHaveBeenCalled();
  });

  it('refuses a misspelt name, listing the projects, and creates nothing', async () => {
    const { target, scopeAccess } = makeTarget(harbor.scope.path);
    const board = await target.resolveBoard({
      projectHint: 'zero-memry',
      sessionDefault: true,
    });
    const failure = board.unwrapErr();
    expect(failure.code).toBe('validation_failed');
    expect(failure.message).toMatch(/^project_hint_unresolvable:/);
    expect(failure.message).toContain(`harbor (${harbor.scope.path})`);
    expect(failure.message).not.toContain('"core"');
    expect(scopeAccess.createScope).not.toHaveBeenCalled();
  });
});
