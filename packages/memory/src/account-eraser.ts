import type { DeleteAccountOutput } from '@workspace/contracts';
import { inject } from '@workspace/di';

/**
 * Port: erase the CURRENT caller's account and everything the ownership map
 * attributes to it.
 *
 * The subject is the authenticated caller, resolved from the execution context
 * inside the adapter — never a parameter — so a caller can only ever erase
 * their own account. Runs the privileged, service-role erasure cascade
 * (`hard_delete_user`), which is idempotent: a second call finds nothing left
 * and is a no-op sweep.
 */
export interface IAccountEraser {
  eraseCurrentAccount(): Promise<DeleteAccountOutput>;
}

export const ACCOUNT_ERASER = Symbol.for('zero-memory:account-eraser');

export const injectAccountEraser = () => inject(ACCOUNT_ERASER);
