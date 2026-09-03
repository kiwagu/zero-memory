import {
  edgeTypeSchema,
  type EdgeType as EdgeTypeValue,
} from '@workspace/contracts';
import { ValueObject } from '@workspace/domain';
import { Err, Ok, type Result } from 'oxide.ts';

/**
 * Type of an entity->entity edge (uses, prefers, depends_on, ...). The
 * vocabulary is closed — it lives in the contracts enum and in the edges
 * table check constraint.
 */
export class EdgeType extends ValueObject<string> {
  private constructor(value: EdgeTypeValue) {
    super({ value });
  }

  static create(value: string): Result<EdgeType, string> {
    const parsed = edgeTypeSchema.safeParse(value);
    if (!parsed.success) {
      return Err(
        `Invalid edge type "${value}": expected one of ` +
          `${edgeTypeSchema.options.join(', ')}.`
      );
    }
    return Ok(new EdgeType(parsed.data));
  }

  get value(): EdgeTypeValue {
    return this.props.value as EdgeTypeValue;
  }
}
