import { cardRefSchema, type CardRef } from '@workspace/contracts';
import { Err, Ok, type Result } from 'oxide.ts';

/**
 * Stable identity of a reference, so the same target attached twice is
 * recognized as one attachment.
 *
 * The key is the pair (kind, target) rather than the whole object: two
 * references to one memory are the same reference no matter when or by whom
 * each was written.
 */
export const cardRefKey = (ref: CardRef): string =>
  ref.kind === 'url' ? `url:${ref.url}` : `${ref.kind}:${ref.id}`;

/** Whether two references point at the same target. */
export const sameCardRef = (left: CardRef, right: CardRef): boolean =>
  cardRefKey(left) === cardRefKey(right);

/**
 * Parse an untrusted reference.
 *
 * The union is closed on purpose: a target the server cannot authorize per
 * viewer has no business on a card, and an arbitrary blob has none either —
 * a card carries pointers, never payloads.
 */
export const parseCardRef = (value: unknown): Result<CardRef, string> => {
  const parsed = cardRefSchema.safeParse(value);
  if (!parsed.success) {
    return Err(
      'Invalid reference: expected a memory, entity, thread, card or url ' +
        'target.'
    );
  }
  return Ok(parsed.data);
};

/**
 * Flatten a reference for storage: the store keeps a kind and an opaque
 * target rather than one column per kind, because the targets are
 * polymorphic and one of them (a url) is not ours at all.
 */
export const flattenCardRef = (
  ref: CardRef
): { kind: CardRef['kind']; target: string } => ({
  kind: ref.kind,
  target: ref.kind === 'url' ? ref.url : ref.id,
});
