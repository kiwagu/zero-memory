import type { MemoryKind } from '@workspace/contracts';

import {
  extractedRelationTypeSchema,
  extractionResultSchema,
  type ExtractedEntity,
  type ExtractedRelation,
  type ExtractionResult,
} from '../extraction.schema.js';
import type { IExtractor } from '../extractor.js';

const PREFIX_TO_KIND: Record<string, MemoryKind> = {
  FACT: 'fact',
  PREF: 'preference',
  PREFERENCE: 'preference',
  DECISION: 'decision',
  CONVENTION: 'convention',
  GOTCHA: 'gotcha',
  REFERENCE: 'reference',
  EPISODE: 'episode',
};

// An optional `user:` / `assistant:` role prefix keeps the grammar working
// on watcher-formatted chunks ("user: DECISION: ...").
const LINE_PATTERN = new RegExp(
  `^\\s*(?:(?:user|assistant):\\s*)?(${Object.keys(PREFIX_TO_KIND).join('|')})(?:@(\\d*\\.?\\d+))?:\\s*(.+)$`,
  'i'
);

const DIRECTIVE_PATTERN = /\[\[(entity|rel|portable)(?::([^\]]+))?\]\]/gi;

const DEFAULT_CONFIDENCE = 0.9;

/**
 * TEST-ONLY extractor: keyword-driven, no model involved. Lines starting
 * with a kind prefix become candidate memories:
 *
 *   DECISION: chose postgres over mysql because of ltree
 *   PREF@0.55: 短いcommitメッセージ
 *   FACT: alpha uses postgres [[entity:alpha|project]] [[rel:alpha|uses|postgres]]
 *   GOTCHA: bun reads .env from cwd only [[portable]]
 *
 * `@<number>` overrides the default confidence (0.9). `[[entity:name|type]]`
 * attaches a mention, `[[rel:src|type|dst]]` a relation, `[[portable]]` marks
 * the fact project-independent; directives are stripped from the stored
 * content. Everything else in the transcript is ignored. Never wire this
 * into production DI; it carries no semantics.
 */
export class DeterministicExtractor implements IExtractor {
  extract(transcript: string): Promise<ExtractionResult> {
    const memories = transcript
      .split('\n')
      .map((line) => this.#parseLine(line))
      .filter((memory) => memory !== null);
    return Promise.resolve(extractionResultSchema.parse({ memories }));
  }

  #parseLine(line: string): {
    content: string;
    kind: MemoryKind;
    confidence: number;
    portable: boolean;
    entities: ExtractedEntity[];
    relations: ExtractedRelation[];
  } | null {
    const match = LINE_PATTERN.exec(line);
    if (!match) {
      return null;
    }
    const kind = PREFIX_TO_KIND[match[1]!.toUpperCase()]!;
    const confidence =
      match[2] !== undefined ? Number(match[2]) : DEFAULT_CONFIDENCE;

    const entities: ExtractedEntity[] = [];
    const relations: ExtractedRelation[] = [];
    let portable = false;
    const content = match[3]!
      .replace(
        DIRECTIVE_PATTERN,
        (_, directive: string, body: string | undefined) => {
          const parts = (body ?? '').split('|').map((part) => part.trim());
          if (directive.toLowerCase() === 'portable') {
            portable = true;
          } else if (
            directive.toLowerCase() === 'entity' &&
            parts.length === 2
          ) {
            entities.push({
              name: parts[0]!,
              // Fall through zod later if the type is not in the vocabulary.
              type: parts[1]! as ExtractedEntity['type'],
            });
          } else if (directive.toLowerCase() === 'rel' && parts.length === 3) {
            relations.push({
              src: parts[0]!,
              type: extractedRelationTypeSchema.parse(parts[1]),
              dst: parts[2]!,
            });
          }
          return '';
        }
      )
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (content.length < 8) {
      return null;
    }
    return { content, kind, confidence, portable, entities, relations };
  }
}
