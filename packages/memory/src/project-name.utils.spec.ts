import { describe, expect, it } from 'vitest';

import {
  matchProjectName,
  projectNameInitials,
  type ProjectCandidate,
} from './project-name.utils.js';
import { Scope } from './scope.vo.js';

const OWNER = 'usr_owner00000000.0000000000';

const OTHER = 'usr_other00000000.0000000000';

const project = (
  slug: string,
  alias: string | null = null
): ProjectCandidate => ({
  scope: Scope.project(OWNER, slug),
  alias,
  own: true,
});

/** A project somebody else owns and shared with the caller. */
const shared = (
  slug: string,
  alias: string | null = null
): ProjectCandidate => ({
  scope: Scope.project(OTHER, slug),
  alias,
  own: false,
});

const zeroMemory = project('zero_memory');
const harbor = project('harbor');
const aiFleet = project('ai_fleet');
const projects = [zeroMemory, harbor, aiFleet];

const matchedSlug = (hint: string, candidates = projects) => {
  const match = matchProjectName(hint, candidates);
  return match.kind === 'match' ? match.project.scope.slug : match.kind;
};

describe('matchProjectName', () => {
  it('matches every spelling of one name to the same project', () => {
    for (const hint of [
      'zero_memory',
      'zero-memory',
      'Zero Memory',
      'ZeroMemory',
      'ZERO-MEMORY',
      ' zero memory ',
    ]) {
      expect(matchedSlug(hint)).toBe('zero_memory');
    }
  });

  it('matches a project by its initials when nothing matches by spelling', () => {
    expect(matchedSlug('ZM')).toBe('zero_memory');
    expect(matchedSlug('af')).toBe('ai_fleet');
  });

  it('matches the scope path itself', () => {
    expect(matchedSlug(zeroMemory.scope.path)).toBe('zero_memory');
  });

  it('matches the alias an admin set, under the same spelling key', () => {
    const aliased = project('workbench', 'Author App');
    expect(matchedSlug('author-app', [...projects, aliased])).toBe('workbench');
    expect(matchedSlug('AA', [...projects, aliased])).toBe('workbench');
  });

  it('prefers a spelling match over another project whose initials fit', () => {
    const zm = project('zm');
    expect(matchedSlug('ZM', [zeroMemory, zm])).toBe('zm');
  });

  it('reports an ambiguous name with every project it fits', () => {
    const zooMap = project('zoo_map');
    const match = matchProjectName('zm', [zeroMemory, zooMap, harbor]);
    expect(match.kind).toBe('ambiguous');
    expect(
      match.kind === 'ambiguous' && match.projects.map((p) => p.scope.slug)
    ).toEqual(['zero_memory', 'zoo_map']);
  });

  it('names a project once even when its slug and alias both fit', () => {
    const aliased = project('zero_memory', 'Zero Memory');
    expect(matchedSlug('zero-memory', [aliased])).toBe('zero_memory');
  });

  it("never lets another owner's alias capture a name that fits the caller's own project", () => {
    const squatter = shared('side_project', 'ZM');
    const match = matchProjectName('ZM', [squatter, zeroMemory]);
    expect(match.kind).toBe('ambiguous');
    expect(
      match.kind === 'ambiguous' && match.projects.map((p) => p.scope.path)
    ).toEqual([squatter.scope.path, zeroMemory.scope.path]);
  });

  it("routes to a project shared with the caller when nothing of the caller's fits", () => {
    const teammate = shared('ember_dunes');
    expect(matchedSlug('Ember Dunes', [...projects, teammate])).toBe(
      'ember_dunes'
    );
  });

  it("keeps the caller's own project when it matches before another owner's", () => {
    const own = project('zm');
    expect(matchedSlug('ZM', [shared('zero_memory'), own])).toBe('zm');
  });

  it('matches nothing for a typo, and never guesses', () => {
    expect(matchedSlug('zero-memry')).toBe('unknown');
    expect(matchedSlug('memory')).toBe('unknown');
  });

  it('does not match a one-word project by a single initial', () => {
    expect(matchedSlug('h')).toBe('unknown');
  });

  it('matches nothing when the caller has no projects', () => {
    expect(matchedSlug('zero-memory', [])).toBe('unknown');
  });
});

describe('projectNameInitials', () => {
  it('takes the first letter of each word, camelCase included', () => {
    expect(projectNameInitials('zero_memory')).toBe('zm');
    expect(projectNameInitials('ZeroMemory')).toBe('zm');
    expect(projectNameInitials('Zero Memory')).toBe('zm');
    expect(projectNameInitials('ai-fleet')).toBe('af');
  });

  it('has no initials for a one-word name', () => {
    expect(projectNameInitials('harbor')).toBeNull();
  });
});
