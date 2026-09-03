import { memoryKindSchema, type MemoryKind } from '@workspace/contracts';
import { ValueObject } from '@workspace/domain';
import { Err, Ok, type Result } from 'oxide.ts';

export interface MemoryContentProps {
  content: string;
  kind: MemoryKind;
}

/**
 * The remembered text plus its kind (fact, decision, gotcha, ...).
 */
export class MemoryContent extends ValueObject<MemoryContentProps> {
  static create(content: string, kind?: string): Result<MemoryContent, string> {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return Err('Memory content must not be empty.');
    }
    const parsedKind = memoryKindSchema.safeParse(kind ?? 'fact');
    if (!parsedKind.success) {
      return Err(
        `Invalid memory kind "${kind}": expected one of ` +
          `${memoryKindSchema.options.join(', ')}.`
      );
    }
    return Ok(new MemoryContent({ content: trimmed, kind: parsedKind.data }));
  }

  get content(): string {
    return this.props.content;
  }

  get kind(): MemoryKind {
    return this.props.kind;
  }
}
