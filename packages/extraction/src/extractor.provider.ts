import { inject } from '@workspace/di';

export const EXTRACTOR = Symbol.for('zero-memory:extractor');

export const injectExtractor = () => inject(EXTRACTOR);
