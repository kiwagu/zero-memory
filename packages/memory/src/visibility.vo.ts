import {
  memoryVisibilitySchema,
  type MemoryVisibility,
} from '@workspace/contracts';
import { ValueObject } from '@workspace/domain';
import { Err, Ok, type Result } from 'oxide.ts';

/**
 * Who may read a memory: only its owner (`private`) or everyone who can see
 * its scope (`shared`). Fail-closed: the default everywhere is `private`.
 */
export class Visibility extends ValueObject<string> {
  private constructor(value: MemoryVisibility) {
    super({ value });
  }

  static create(value: string): Result<Visibility, string> {
    const parsed = memoryVisibilitySchema.safeParse(value);
    if (!parsed.success) {
      return Err(`Invalid visibility "${value}": expected private | shared.`);
    }
    return Ok(new Visibility(parsed.data));
  }

  static private(): Visibility {
    return new Visibility('private');
  }

  static shared(): Visibility {
    return new Visibility('shared');
  }

  get level(): MemoryVisibility {
    return this.props.value as MemoryVisibility;
  }

  get isShared(): boolean {
    return this.level === 'shared';
  }
}
