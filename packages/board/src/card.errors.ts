/**
 * Why a board call did not do what was asked.
 *
 * The codes are the store's, not this layer's invention: the card commands
 * return one of them instead of raising, because every one of these is a
 * caller-fixable answer rather than a fault.
 */
export const CARD_FAILURES = [
  'not_found',
  'forbidden',
  'archived',
  'same_state',
  'conflict',
  'not_attached',
  'already_promoted',
  'invalid',
] as const;
export type CardFailureCode = (typeof CARD_FAILURES)[number];

export interface CardFailure {
  code: CardFailureCode;
  message: string;
}

const DEFAULT_MESSAGE: Record<CardFailureCode, string> = {
  not_found: 'No such card in a scope you can read.',
  forbidden: 'You can read this card but not write to it.',
  archived: 'This card is archived and no longer accepts changes.',
  same_state: 'The card is already in that state; a move must change it.',
  conflict: 'The card moved on since you read it — read it again and retry.',
  not_attached: 'Nothing is attached under that reference.',
  already_promoted: 'That loop already has a card.',
  invalid: 'The call is not a valid card command.',
};

/** True when the string is one of the store's failure codes. */
export const isCardFailureCode = (
  value: string | undefined
): value is CardFailureCode =>
  value !== undefined && (CARD_FAILURES as readonly string[]).includes(value);

/**
 * Turn a command's `{error, message}` payload into a failure.
 *
 * An unrecognized code becomes `invalid` rather than being passed through: a
 * caller should never have to branch on a string this layer does not know.
 */
export const toCardFailure = (
  code: string | undefined,
  message?: string | null
): CardFailure => {
  const known: CardFailureCode = isCardFailureCode(code) ? code : 'invalid';
  return {
    code: known,
    message: message?.trim() ? message.trim() : DEFAULT_MESSAGE[known],
  };
};

/**
 * Map a board failure onto the transport's error vocabulary.
 *
 * `archived`, `same_state`, `not_attached` and `already_promoted` all become
 * `conflict`: each one means the card exists and the caller may touch it, but
 * its current state refuses this particular call — which is exactly what
 * `conflict` says. The message keeps the specific reason.
 */
export const cardFailureToErrorCode = (
  failure: CardFailure
): 'validation_failed' | 'not_found' | 'forbidden' | 'conflict' => {
  switch (failure.code) {
    case 'invalid':
      return 'validation_failed';
    case 'not_found':
      return 'not_found';
    case 'forbidden':
      return 'forbidden';
    default:
      return 'conflict';
  }
};
