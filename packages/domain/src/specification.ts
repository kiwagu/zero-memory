import type { Option, Result } from 'oxide.ts';
import { None, Ok, Some } from 'oxide.ts';

export interface ISpecVisitor {
  and(left: ISpecification, right: ISpecification): this;
  or(left: ISpecification, right: ISpecification): this;
  not(spec: ISpecification): this;
  clone(): this;
}

export interface ISpecification<
  T = unknown,
  V extends ISpecVisitor = ISpecVisitor,
> {
  isSatisfiedBy(candidate: T): boolean;
  mutate(candidate: T): Result<T, string>;
  accept(visitor: V): Result<void, string>;
}

/**
 * Composable specification: combine with `and` / `or` / `not`.
 */
export abstract class CompositeSpecification<
  T = unknown,
  V extends ISpecVisitor = ISpecVisitor,
> implements ISpecification<T, V> {
  abstract isSatisfiedBy(candidate: T): boolean;
  abstract mutate(candidate: T): Result<T, string>;
  abstract accept(visitor: V): Result<void, string>;

  and(spec: ISpecification<T, V>): CompositeSpecification<T, V> {
    return new And(this, spec);
  }

  or(spec: ISpecification<T, V>): CompositeSpecification<T, V> {
    return new Or(this, spec);
  }

  not(): Not<T, V> {
    return new Not(this);
  }
}

export class And<T, V extends ISpecVisitor> extends CompositeSpecification<
  T,
  V
> {
  constructor(
    public readonly left: ISpecification<T, V>,
    public readonly right: ISpecification<T, V>
  ) {
    super();
  }

  isSatisfiedBy(candidate: T): boolean {
    return (
      this.left.isSatisfiedBy(candidate) && this.right.isSatisfiedBy(candidate)
    );
  }

  mutate(candidate: T): Result<T, string> {
    return this.left.mutate(candidate).and(this.right.mutate(candidate));
  }

  accept(visitor: V): Result<void, string> {
    visitor.and(this.left, this.right);
    return Ok(undefined);
  }
}

export class Or<T, V extends ISpecVisitor> extends CompositeSpecification<
  T,
  V
> {
  constructor(
    public readonly left: ISpecification<T, V>,
    public readonly right: ISpecification<T, V>
  ) {
    super();
  }

  isSatisfiedBy(candidate: T): boolean {
    return (
      this.left.isSatisfiedBy(candidate) || this.right.isSatisfiedBy(candidate)
    );
  }

  mutate(candidate: T): Result<T, string> {
    return this.left
      .mutate(candidate)
      .orElse(() => this.right.mutate(candidate));
  }

  accept(visitor: V): Result<void, string> {
    visitor.or(this.left, this.right);
    return Ok(undefined);
  }
}

export class Not<T, V extends ISpecVisitor> extends CompositeSpecification<
  T,
  V
> {
  constructor(public readonly spec: ISpecification<T, V>) {
    super();
  }

  isSatisfiedBy(candidate: T): boolean {
    return !this.spec.isSatisfiedBy(candidate);
  }

  mutate(): Result<T, string> {
    throw new Error('A negated specification cannot mutate a candidate.');
  }

  accept(visitor: V): Result<void, string> {
    visitor.not(this.spec);
    return Ok(undefined);
  }
}

export const and = <T, V extends ISpecVisitor>(
  ...specs: CompositeSpecification<T, V>[]
): Option<CompositeSpecification<T, V>> => {
  const [first, ...rest] = specs;
  if (!first) return None;
  return Some(rest.reduce((acc, spec) => acc.and(spec), first));
};

export const or = <T, V extends ISpecVisitor>(
  ...specs: CompositeSpecification<T, V>[]
): Option<CompositeSpecification<T, V>> => {
  const [first, ...rest] = specs;
  if (!first) return None;
  return Some(rest.reduce((acc, spec) => acc.or(spec), first));
};

export const andOptions = <T, V extends ISpecVisitor>(
  ...specs: Option<CompositeSpecification<T, V>>[]
): Option<CompositeSpecification<T, V>> =>
  and(...specs.filter((spec) => spec.isSome()).map((spec) => spec.unwrap()));

export const orOptions = <T, V extends ISpecVisitor>(
  ...specs: Option<CompositeSpecification<T, V>>[]
): Option<CompositeSpecification<T, V>> =>
  or(...specs.filter((spec) => spec.isSome()).map((spec) => spec.unwrap()));
