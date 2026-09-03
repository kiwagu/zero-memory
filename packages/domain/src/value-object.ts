import { dequal } from 'dequal';

export type Primitive = string | number | boolean | null;

export interface DomainPrimitive<T extends Primitive | Date> {
  value: T;
}

type ValueObjectProps<T> = T extends Primitive | Date ? DomainPrimitive<T> : T;

/**
 * Immutable object compared by structural equality of its props.
 */
export abstract class ValueObject<T = unknown> {
  constructor(public readonly props: ValueObjectProps<T>) {}

  static isValueObject(candidate: unknown): candidate is ValueObject<unknown> {
    return candidate instanceof ValueObject;
  }

  equals(other?: ValueObject<T>): boolean {
    if (other === null || other === undefined) {
      return false;
    }
    return dequal(this, other);
  }

  get value(): T {
    return this.unpack();
  }

  unpack(): T {
    if (this.isDomainPrimitive(this.props)) {
      return this.props.value;
    }

    if (Array.isArray(this.props)) {
      return this.props.map((item) =>
        ValueObject.isValueObject(item) ? item.unpack() : item
      ) as unknown as T;
    }

    return Object.freeze({ ...(this.props as object) }) as T;
  }

  private isDomainPrimitive(
    props: unknown
  ): props is DomainPrimitive<T & (Primitive | Date)> {
    return (
      typeof props === 'object' &&
      props !== null &&
      Object.prototype.hasOwnProperty.call(props, 'value')
    );
  }
}
