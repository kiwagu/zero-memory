import { inject } from '@workspace/di';

export const TRANSLATOR = Symbol.for('zero-memory:translator');

export const injectTranslator = () => inject(TRANSLATOR);
