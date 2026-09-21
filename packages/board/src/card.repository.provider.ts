import { inject } from '@workspace/di';

export type { ICardRepository } from './card.repository.js';

export const CARD_REPOSITORY = Symbol.for('zero-memory:card-repository');

export const injectCardRepository = () => inject(CARD_REPOSITORY);
