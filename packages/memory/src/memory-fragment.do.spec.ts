import type { MemoryId, UserId } from '@workspace/contracts';
import { describe, expect, it } from 'vitest';

import { MemoryContent } from './memory-content.vo.js';
import { MemoryFragment } from './memory-fragment.do.js';
import {
  MEMORY_INVALIDATED,
  MEMORY_REMEMBERED,
  MEMORY_SHARED,
} from './memory.events.js';
import { Provenance } from './provenance.vo.js';
import { Scope } from './scope.vo.js';

const OWNER = 'usr_000000000000000a.0000000000' as UserId;
const OTHER_USER = 'usr_000000000000000b.0000000000' as UserId;

const makeFragment = () =>
  MemoryFragment.create({
    content: MemoryContent.create('bun test needs CI=1', 'gotcha').unwrap(),
    scope: Scope.user(OWNER),
    provenance: Provenance.create({ ownerId: OWNER }),
  }).unwrap();

describe('MemoryFragment', () => {
  it('create() defaults to private visibility and raises MemoryRemembered', () => {
    const fragment = makeFragment();
    expect(fragment.id).toMatch(/^mem_[0-9a-z]{16}\.[0-9a-z]{10}$/);
    expect(fragment.visibility.level).toBe('private');
    expect(fragment.lifecycle.isInvalidated).toBe(false);
    expect(fragment.domainEvents).toHaveLength(1);
    expect(fragment.domainEvents[0]?.name).toBe(MEMORY_REMEMBERED);
    expect(fragment.domainEvents[0]?.payload).toMatchObject({
      memoryId: fragment.id,
      kind: 'gotcha',
      ownerId: OWNER,
    });
  });

  it('rejects empty content at the value object boundary', () => {
    expect(MemoryContent.create('   ').isErr()).toBe(true);
    expect(MemoryContent.create('x', 'nonsense').isErr()).toBe(true);
  });

  it('invalidate() closes the fragment once', () => {
    const fragment = makeFragment();
    const first = fragment.invalidate(OTHER_USER);
    expect(first.isOk()).toBe(true);
    expect(fragment.lifecycle.isInvalidated).toBe(true);
    expect(fragment.lifecycle.invalidatedBy).toBe(OTHER_USER);
    expect(fragment.domainEvents.map((event) => event.name)).toContain(
      MEMORY_INVALIDATED
    );

    const second = fragment.invalidate(OTHER_USER);
    expect(second.isErr()).toBe(true);
  });

  it('supersede() records the successor and invalidates', () => {
    const fragment = makeFragment();
    const successor = 'mem_0000000000000009.0000000000' as MemoryId;
    const result = fragment.supersede(successor, OWNER);
    expect(result.isOk()).toBe(true);
    expect(fragment.lifecycle.supersededBy).toBe(successor);
    expect(fragment.lifecycle.isInvalidated).toBe(true);
  });

  it('supersede() refuses self-reference and double closure', () => {
    const fragment = makeFragment();
    expect(fragment.supersede(fragment.id, OWNER).isErr()).toBe(true);
    fragment.invalidate(OWNER);
    expect(
      fragment
        .supersede('mem_000000000000000a.0000000000' as MemoryId, OWNER)
        .isErr()
    ).toBe(true);
  });

  it('share() widens scope + visibility and raises MemoryShared', () => {
    const fragment = makeFragment();
    const target = Scope.create('proj.alpha').unwrap();

    const result = fragment.share(target, OWNER);

    expect(result.isOk()).toBe(true);
    expect(fragment.visibility.level).toBe('shared');
    expect(fragment.scope.path).toBe('proj.alpha');
    expect(fragment.lifecycle.sharedBy).toBe(OWNER);
    expect(fragment.lifecycle.sharedAt).not.toBeNull();
    const shared = fragment.domainEvents.find(
      (event) => event.name === MEMORY_SHARED
    );
    expect(shared?.payload).toMatchObject({
      memoryId: fragment.id,
      scope: 'proj.alpha',
      sharedBy: OWNER,
    });
  });

  it('share() is owner-only and refuses invalidated fragments', () => {
    const fragment = makeFragment();
    const target = Scope.create('proj.alpha').unwrap();

    expect(fragment.share(target, OTHER_USER).isErr()).toBe(true);
    expect(fragment.visibility.level).toBe('private');

    fragment.invalidate(OWNER);
    expect(fragment.share(target, OWNER).isErr()).toBe(true);
  });

  it('share() to the same scope twice is a no-op', () => {
    const fragment = makeFragment();
    const target = Scope.create('proj.alpha').unwrap();
    fragment.share(target, OWNER);
    const eventsAfterFirst = fragment.domainEvents.length;

    const second = fragment.share(target, OWNER);

    expect(second.isOk()).toBe(true);
    expect(fragment.domainEvents).toHaveLength(eventsAfterFirst);
  });
});
