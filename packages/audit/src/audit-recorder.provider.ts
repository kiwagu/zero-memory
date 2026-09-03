import { inject } from '@workspace/di';

export const AUDIT_RECORDER = Symbol.for('zero-memory:audit-recorder');

export const injectAuditRecorder = () => inject(AUDIT_RECORDER);
