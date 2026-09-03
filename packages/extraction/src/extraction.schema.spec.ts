import { describe, expect, it } from 'vitest';

import { parseExtractionLenient } from './extraction.schema.js';

describe('parseExtractionLenient', () => {
  it('passes valid output through unchanged', () => {
    const { result, dropped } = parseExtractionLenient({
      memories: [
        {
          content: 'chose postgres over mysql because of ltree',
          kind: 'decision',
          confidence: 0.9,
          entities: [{ name: 'postgres', type: 'service' }],
          relations: [{ src: 'app', dst: 'postgres', type: 'uses' }],
        },
      ],
    });
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.relations).toHaveLength(1);
    expect(dropped).toEqual({ memories: 0, entities: 0, relations: 0 });
  });

  it('drops an out-of-vocabulary relation but keeps the memory and valid parts', () => {
    const { result, dropped } = parseExtractionLenient({
      memories: [
        {
          content: 'the service configures postgres via an operator',
          kind: 'fact',
          confidence: 0.8,
          entities: [{ name: 'postgres', type: 'service' }],
          relations: [
            { src: 'operator', dst: 'postgres', type: 'configures' }, // invalid
            { src: 'operator', dst: 'postgres', type: 'uses' }, // valid
          ],
        },
      ],
    });
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.relations).toEqual([
      { src: 'operator', dst: 'postgres', type: 'uses' },
    ]);
    expect(result.memories[0]!.entities).toHaveLength(1);
    expect(dropped.relations).toBe(1);
    expect(dropped.memories).toBe(0);
  });

  it('drops self-loop relations, including spelling variants of one name', () => {
    const { result, dropped } = parseExtractionLenient({
      memories: [
        {
          content: 'the importer project owns the importer repository layout',
          kind: 'fact',
          confidence: 0.8,
          entities: [{ name: 'quokka-importer', type: 'service' }],
          relations: [
            // Literal self-loop.
            { src: 'quokka-importer', dst: 'quokka-importer', type: 'uses' },
            // Self-loop by canonical name: separators and case unified.
            { src: 'quokka_importer', dst: 'Quokka Importer', type: 'part_of' },
            // A real relation survives.
            { src: 'quokka-importer', dst: 'postgres', type: 'depends_on' },
          ],
        },
      ],
    });
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.relations).toEqual([
      { src: 'quokka-importer', dst: 'postgres', type: 'depends_on' },
    ]);
    expect(dropped.relations).toBe(2);
  });

  it('drops an invalid entity type, keeping the memory', () => {
    const { result, dropped } = parseExtractionLenient({
      memories: [
        {
          content: 'a durable fact about the alpha project',
          kind: 'fact',
          confidence: 0.7,
          entities: [
            { name: 'alpha', type: 'workspace' }, // invalid type
            { name: 'alpha', type: 'project' }, // valid
          ],
          relations: [],
        },
      ],
    });
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.entities).toEqual([
      { name: 'alpha', type: 'project' },
    ]);
    expect(dropped.entities).toBe(1);
  });

  it('drops a whole memory when its core fields are invalid', () => {
    const { result, dropped } = parseExtractionLenient({
      memories: [
        { content: 'too short', kind: 'not-a-kind', confidence: 2 },
        {
          content: 'a valid durable fact worth keeping',
          kind: 'fact',
          confidence: 0.9,
        },
      ],
    });
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.content).toMatch(/valid durable fact/);
    expect(dropped.memories).toBe(1);
  });

  it('returns an empty result for structurally broken output', () => {
    expect(parseExtractionLenient(null).result.memories).toEqual([]);
    expect(parseExtractionLenient({ nope: true }).result.memories).toEqual([]);
  });

  it('drops open-loop kinds: loops are opened deliberately, never extracted', () => {
    const { result, dropped } = parseExtractionLenient({
      memories: [
        {
          content: 'check the failing watcher logs on the stage machine',
          kind: 'task',
          confidence: 0.9,
        },
        {
          content: 'is the retry budget of the ingest hook large enough?',
          kind: 'open-question',
          confidence: 0.9,
        },
        {
          content: 'a valid durable fact worth keeping',
          kind: 'fact',
          confidence: 0.9,
        },
      ],
    });
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.kind).toBe('fact');
    expect(dropped.memories).toBe(2);
  });
});
