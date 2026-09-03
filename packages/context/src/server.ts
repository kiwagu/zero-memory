import { AsyncLocalStorage } from 'node:async_hooks';

import { container, singleton } from '@workspace/di';

import {
  CONTEXT_TOKEN,
  type ExecuteContext,
  type IContext,
  type SetContextValue,
} from './context.type.js';

export const executionContext = new AsyncLocalStorage<ExecuteContext>();

export const runWithContext = <T>(context: ExecuteContext, fn: () => T): T =>
  executionContext.run(context, fn);

export const setContextValue: SetContextValue = (key, value) => {
  const store = executionContext.getStore();
  if (store) {
    store[key] = value;
  }
};

export const getRequestId = (): string | undefined =>
  executionContext.getStore()?.requestId;

export const getCurrentSessionId = (): string | undefined =>
  executionContext.getStore()?.sessionId ?? undefined;

export const getCurrentUserId = (): string | undefined => {
  const userId = executionContext.getStore()?.user?.userId;
  return userId ?? undefined;
};

export const mustGetCurrentUserId = (): string => {
  const userId = getCurrentUserId();
  if (!userId) {
    throw new Error('No authenticated user in the execution context.');
  }
  return userId;
};

export const getCurrentUserEntityId = (): string | undefined =>
  executionContext.getStore()?.userEntityId ?? undefined;

export const mustGetCurrentUserEntityId = (): string => {
  const userEntityId = getCurrentUserEntityId();
  if (!userEntityId) {
    throw new Error('No user entity id (usr_) in the execution context.');
  }
  return userEntityId;
};

export const getAccessToken = (): string | undefined =>
  executionContext.getStore()?.accessToken;

export const getScopes = (): string[] =>
  executionContext.getStore()?.scopes ?? [];

export const getDefaultScope = (): string | undefined =>
  executionContext.getStore()?.defaultScope;

@singleton()
export class ServerContext implements IContext {
  setContextValue: SetContextValue = setContextValue;

  mustGetCurrentUserId(): string {
    return mustGetCurrentUserId();
  }

  getCurrentUserId(): string | undefined {
    return getCurrentUserId();
  }

  mustGetCurrentUserEntityId(): string {
    return mustGetCurrentUserEntityId();
  }

  getCurrentUserEntityId(): string | undefined {
    return getCurrentUserEntityId();
  }

  getAccessToken(): string | undefined {
    return getAccessToken();
  }

  getScopes(): string[] {
    return getScopes();
  }

  getDefaultScope(): string | undefined {
    return getDefaultScope();
  }

  getCurrentSessionId(): string | undefined {
    return getCurrentSessionId();
  }
}

export const registerContext = (c = container): void => {
  c.register(CONTEXT_TOKEN, { useClass: ServerContext });
};
