import type { IContext } from '@workspace/context';
import { None, Ok, Some } from 'oxide.ts';
import { describe, expect, it, vi } from 'vitest';

import type { IProjectBindingRepository } from './project-binding.repository.js';
import type { ProjectCandidate } from './project-name.utils.js';
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
const zooMap: ProjectCandidate = {
  scope: Scope.project(OWNER, 'zoo_map'),
  alias: null,
  own: true,
};

const makeRouting = (
  projects: ProjectCandidate[] = [zeroMemory, harbor],
  canWrite = false
) => {
  const bindings: IProjectBindingRepository = {
    findScope: vi.fn().mockResolvedValue(None),
    insert: vi.fn().mockResolvedValue(Ok(undefined)),
  };
  const scopeAccess: IScopeAccessService = {
    canWrite: vi.fn().mockResolvedValue(canWrite),
    createScope: vi.fn().mockResolvedValue(Ok(undefined)),
    listMemberProjects: vi.fn().mockResolvedValue(Ok(projects)),
  };
  return {
    routing: new ScopeRoutingService(bindings, scopeAccess, context),
    bindings,
    scopeAccess,
  };
};

describe('ScopeRoutingService — a project NAME', () => {
  it('routes every spelling of an existing project to that project', async () => {
    const { routing } = makeRouting();
    for (const hint of ['ZM', 'Zero Memory', 'zero-memory', 'ZeroMemory']) {
      const scope = await routing.resolveProjectScope(hint);
      expect(scope.path).toBe(zeroMemory.scope.path);
    }
  });

  it('never creates a project or a binding for a name', async () => {
    const { routing, scopeAccess, bindings } = makeRouting();
    await routing.resolveProjectScope('zero-memry');
    await routing.resolveProjectScope('ZeroMemory');
    expect(scopeAccess.createScope).not.toHaveBeenCalled();
    expect(bindings.insert).not.toHaveBeenCalled();
  });

  it('degrades an unknown name to the personal scope for callers that read', async () => {
    const { routing } = makeRouting();
    const scope = await routing.resolveProjectScope('zero-memry');
    expect(scope.isPersonal).toBe(true);
  });

  it('refuses an unknown name as a target, listing the projects to choose from', async () => {
    const { routing } = makeRouting();
    const target = await routing.resolveProjectTarget('zero-memry');
    expect(target.isErr()).toBe(true);
    const miss = target.unwrapErr();
    expect(miss.reason).toBe('unknown');
    expect(miss.projects.map((p) => p.scope.slug)).toEqual([
      'zero_memory',
      'harbor',
    ]);
  });

  it('refuses an ambiguous name as a target, listing only the projects it fits', async () => {
    const { routing } = makeRouting([zeroMemory, zooMap, harbor]);
    const miss = (await routing.resolveProjectTarget('zm')).unwrapErr();
    expect(miss.reason).toBe('ambiguous');
    expect(miss.projects.map((p) => p.scope.slug)).toEqual([
      'zero_memory',
      'zoo_map',
    ]);
  });

  it('resolves a matching name as a target', async () => {
    const { routing } = makeRouting();
    const target = await routing.resolveProjectTarget('zero_memory');
    expect(target.unwrap().path).toBe(zeroMemory.scope.path);
  });
});

describe('ScopeRoutingService — a path or a git remote', () => {
  it('still sets up a new project the first time a repository is seen', async () => {
    const { routing, scopeAccess, bindings } = makeRouting();
    const scope = await routing.resolveProjectScope('/home/dev/repos/new-app');
    expect(scope.path).toBe(Scope.project(OWNER, 'new_app').path);
    expect(scopeAccess.createScope).toHaveBeenCalledOnce();
    expect(bindings.insert).toHaveBeenCalledOnce();
  });

  it('follows an existing binding', async () => {
    const { routing, bindings } = makeRouting();
    vi.mocked(bindings.findScope).mockResolvedValue(Some(harbor.scope));
    const target = await routing.resolveProjectTarget(
      'git@github.com:acme/harbor.git'
    );
    expect(target.unwrap().path).toBe(harbor.scope.path);
  });
});
