import { inject } from '@workspace/di';

export const USAGE_RECORDER = Symbol.for('zero-memory:usage-recorder');

export const injectUsageRecorder = () => inject(USAGE_RECORDER);
