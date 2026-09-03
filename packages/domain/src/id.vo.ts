import { customAlphabet } from 'nanoid';

import { ValueObject } from './value-object.js';

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const DEFAULT_ID_SIZE = 10;

/**
 * Base identifier value object. Concrete ids are created via `IdFactory`.
 */
export abstract class ID extends ValueObject<string> {
  constructor(value: string) {
    super({ value });
  }

  override get value(): string {
    return this.props.value;
  }
}

export interface IdClass {
  new (value: string): ID;
  create(suffix?: string): ID;
  fromString(value: string): ID;
  fromStringOrCreate(value?: string): ID;
}

/**
 * Builds a prefixed nanoid-backed ID class, e.g. `IdFactory('mem')`.
 */
export const IdFactory = (prefix: string, size = DEFAULT_ID_SIZE): IdClass => {
  const generate = customAlphabet(ID_ALPHABET, size);

  return class extends ID {
    static create(suffix = generate()): ID {
      return new this(`${prefix}${suffix}`);
    }

    static fromString(value: string): ID {
      return new this(value);
    }

    static fromStringOrCreate(value?: string): ID {
      return value ? new this(value) : this.create();
    }
  };
};
