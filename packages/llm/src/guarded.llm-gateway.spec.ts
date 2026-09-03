import {
  BudgetExhaustedError,
  BudgetGuard,
  type IPolicyProvider,
  type ISpendMeter,
} from '@workspace/policy';
import { describe, expect, it, vi } from 'vitest';

import type { ICredentialResolver, ResolvedCredential } from './credential.js';
import { GuardedLlmGateway } from './guarded.llm-gateway.js';
import type { LlmPurpose, LlmToolCallRequest } from './llm-gateway.js';

const requestFor = (purpose: LlmPurpose): LlmToolCallRequest => ({
  model: 'a-model',
  maxOutputTokens: 128,
  system: 'a policy',
  prompt: 'a prompt',
  tool: { name: 'record', description: 'records', inputSchema: {} },
  purpose,
});

const routerOf = () => ({
  callTool: vi.fn(() =>
    Promise.resolve({
      input: { ok: true },
      model: 'a-model',
      inputTokens: 10,
      outputTokens: 5,
      ranOnCallerKey: false,
    })
  ),
  searchWeb: vi.fn(() =>
    Promise.resolve({
      text: 'grounded answer',
      sources: [],
      exhausted: false,
      model: 'a-model',
      inputTokens: 10,
      outputTokens: 5,
      ranOnCallerKey: false,
    })
  ),
});

const platformKey: ResolvedCredential = {
  provider: 'anthropic',
  apiKey: 'platform-key',
  ownedByCaller: false,
};

const callerKey: ResolvedCredential = {
  provider: 'openai',
  apiKey: 'caller-key',
  model: 'gpt-4o-mini',
  ownedByCaller: true,
};

const credentialsOf = (
  credential: ResolvedCredential
): ICredentialResolver => ({
  resolve: () => Promise.resolve(credential),
  usesOwnCredential: () => Promise.resolve(credential.ownedByCaller),
});

const limitOf = (limit: number | null): IPolicyProvider => ({
  source: 'test',
  policyFor: () => Promise.resolve({ limit }),
});

const meterOf = (spent: number): ISpendMeter => ({
  spent: () => Promise.resolve(spent),
});

describe('GuardedLlmGateway', () => {
  it('passes the call through when there is budget left', async () => {
    const router = routerOf();
    const gateway = new GuardedLlmGateway(
      router,
      new BudgetGuard([limitOf(100)], meterOf(10)),
      credentialsOf(platformKey),
      () => 'usr_1'
    );

    await expect(
      gateway.callTool(requestFor('extraction'))
    ).resolves.toMatchObject({ input: { ok: true } });
    expect(router.callTool).toHaveBeenCalledOnce();
  });

  it('never reaches the model once the budget is gone', async () => {
    const router = routerOf();
    const gateway = new GuardedLlmGateway(
      router,
      new BudgetGuard([limitOf(100)], meterOf(100)),
      credentialsOf(platformKey),
      () => 'usr_1'
    );

    await expect(
      gateway.callTool(requestFor('extraction'))
    ).rejects.toBeInstanceOf(BudgetExhaustedError);
    // The point of checking before the call rather than after: an exhausted
    // budget must not be able to spend one more call proving it is exhausted.
    expect(router.callTool).not.toHaveBeenCalled();
  });

  it('counts work with no subject against the instance, not a user', async () => {
    const spent = vi.fn(() => Promise.resolve(0));
    const gateway = new GuardedLlmGateway(
      routerOf(),
      new BudgetGuard([limitOf(100)], { spent }),
      credentialsOf(platformKey),
      () => null
    );

    await gateway.callTool(requestFor('hygiene_judge'));

    expect(spent).toHaveBeenCalledWith('maintenance', expect.any(Number), null);
  });

  it('counts a judge run for a user against that user', async () => {
    const spent = vi.fn(() => Promise.resolve(0));
    const gateway = new GuardedLlmGateway(
      routerOf(),
      new BudgetGuard([limitOf(100)], { spent }),
      credentialsOf(platformKey),
      () => 'usr_1'
    );

    await gateway.callTool(requestFor('usefulness_judge'));

    expect(spent).toHaveBeenCalledWith(
      'extraction',
      expect.any(Number),
      'usr_1'
    );
  });

  it.each<LlmPurpose>(['translation', 'translation_faithfulness'])(
    'keeps %s on its own budget',
    async (purpose) => {
      const spent = vi.fn(() => Promise.resolve(0));
      const gateway = new GuardedLlmGateway(
        routerOf(),
        new BudgetGuard([limitOf(100)], { spent }),
        credentialsOf(platformKey),
        () => 'usr_1'
      );

      await gateway.callTool(requestFor(purpose));

      expect(spent).toHaveBeenCalledWith(
        'translation',
        expect.any(Number),
        'usr_1'
      );
    }
  );

  it('lets everything through when nothing is configured', async () => {
    const router = routerOf();
    const gateway = new GuardedLlmGateway(
      router,
      new BudgetGuard([], meterOf(Number.MAX_SAFE_INTEGER)),
      credentialsOf(platformKey),
      () => 'usr_1'
    );

    await gateway.callTool(requestFor('extraction'));

    expect(router.callTool).toHaveBeenCalledOnce();
  });
});

describe('work done for a user, outside any request', () => {
  it('runs on that user, not on the instance', async () => {
    const spent = vi.fn(() => Promise.resolve(0));
    const gateway = new GuardedLlmGateway(
      routerOf(),
      new BudgetGuard([limitOf(100)], { spent }),
      credentialsOf(platformKey),
      // No ambient user: this is background upkeep.
      () => null
    );

    await gateway.callTool({
      ...requestFor('hygiene_judge'),
      subjectId: 'usr_owner',
    });

    // Against the owner's allowance, not the instance's — upkeep of someone's
    // corpus is work done for them.
    expect(spent).toHaveBeenCalledWith(
      'extraction',
      expect.any(Number),
      'usr_owner'
    );
  });

  it("resolves that user's credential, so their own key covers their upkeep", async () => {
    const resolve = vi.fn(() => Promise.resolve(platformKey));
    const gateway = new GuardedLlmGateway(
      routerOf(),
      new BudgetGuard([], meterOf(0)),
      { resolve, usesOwnCredential: () => Promise.resolve(false) },
      () => null
    );

    await gateway.callTool({
      ...requestFor('reflection'),
      subjectId: 'usr_owner',
    });

    expect(resolve).toHaveBeenCalledWith('usr_owner');
  });

  it('still counts against the instance when no owner is named', async () => {
    const spent = vi.fn(() => Promise.resolve(0));
    const gateway = new GuardedLlmGateway(
      routerOf(),
      new BudgetGuard([limitOf(100)], { spent }),
      credentialsOf(platformKey),
      () => null
    );

    await gateway.callTool(requestFor('hygiene_judge'));

    expect(spent).toHaveBeenCalledWith('maintenance', expect.any(Number), null);
  });
});

describe('a caller running on their own key', () => {
  it('is not capped, however exhausted the platform budget is', async () => {
    const router = routerOf();
    const gateway = new GuardedLlmGateway(
      router,
      new BudgetGuard([limitOf(1)], meterOf(10_000)),
      credentialsOf(callerKey),
      () => 'usr_1'
    );

    await gateway.callTool(requestFor('extraction'));

    expect(router.callTool).toHaveBeenCalledOnce();
  });

  it('is not even metered — no spend is looked up', async () => {
    const spent = vi.fn(() => Promise.resolve(0));
    const gateway = new GuardedLlmGateway(
      routerOf(),
      new BudgetGuard([limitOf(1)], { spent }),
      credentialsOf(callerKey),
      () => 'usr_1'
    );

    await gateway.callTool(requestFor('extraction'));

    expect(spent).not.toHaveBeenCalled();
  });

  it('reaches the vendor their credential names, with their key', async () => {
    const router = routerOf();
    const gateway = new GuardedLlmGateway(
      router,
      new BudgetGuard([], meterOf(0)),
      credentialsOf(callerKey),
      () => 'usr_1'
    );

    await gateway.callTool(requestFor('extraction'));

    expect(router.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'extraction' }),
      expect.objectContaining({
        provider: 'openai',
        apiKey: 'caller-key',
        ownedByCaller: true,
      })
    );
  });

  it('marks the result, so metering can leave that spend out of the ledger', async () => {
    const gateway = new GuardedLlmGateway(
      routerOf(),
      new BudgetGuard([], meterOf(0)),
      credentialsOf(callerKey),
      () => 'usr_1'
    );

    const result = await gateway.callTool(requestFor('extraction'));

    // The router reports false; the gateway is the only layer that knows
    // whose key was chosen, so its answer is the one that counts.
    expect(result.ranOnCallerKey).toBe(true);
  });

  it('leaves platform-key calls unmarked', async () => {
    const gateway = new GuardedLlmGateway(
      routerOf(),
      new BudgetGuard([], meterOf(0)),
      credentialsOf(platformKey),
      () => 'usr_1'
    );

    const result = await gateway.callTool(requestFor('extraction'));

    expect(result.ranOnCallerKey).toBe(false);
  });

  it('is resolved once per call, not twice', async () => {
    const resolve = vi.fn(() => Promise.resolve(callerKey));
    const gateway = new GuardedLlmGateway(
      routerOf(),
      new BudgetGuard([], meterOf(0)),
      { resolve, usesOwnCredential: () => Promise.resolve(true) },
      () => 'usr_1'
    );

    await gateway.callTool(requestFor('extraction'));

    expect(resolve).toHaveBeenCalledOnce();
  });
});
