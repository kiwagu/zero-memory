import { describe, expect, it, vi } from 'vitest';

import { BudgetExhaustedError } from './budget-exhausted.error.js';
import { BudgetGuard, type BudgetDecision } from './budget-guard.js';
import { EnvPolicyProvider } from './env.policy-provider.js';
import type { IPolicyProvider } from './policy.js';
import type { ISpendMeter } from './spend-meter.js';

const meterOf = (spent: number): ISpendMeter => ({
  spent: () => Promise.resolve(spent),
});

const providerOf = (
  source: string,
  limit: number | null,
  windowDays?: number
): IPolicyProvider => ({
  source,
  policyFor: () =>
    Promise.resolve(
      windowDays === undefined ? { limit } : { limit, windowDays }
    ),
});

describe('BudgetGuard', () => {
  it('allows everything when nothing is configured', async () => {
    const guard = new BudgetGuard([], meterOf(999_999_999));

    const decision = await guard.check('extraction', { subjectId: 'usr_1' });

    expect(decision).toMatchObject({
      allowed: true,
      limit: null,
      source: 'default',
    });
  });

  it('never queries the meter for an unlimited budget', async () => {
    const spent = vi.fn(() => Promise.resolve(0));
    const guard = new BudgetGuard([], { spent });

    await guard.check('extraction', { subjectId: 'usr_1' });

    expect(spent).not.toHaveBeenCalled();
  });

  it('allows while under the limit and blocks once it is reached', async () => {
    const providers = [providerOf('env', 100)];

    await expect(
      new BudgetGuard(providers, meterOf(99)).check('extraction', {
        subjectId: 'u',
      })
    ).resolves.toMatchObject({ allowed: true, remaining: 1 });

    await expect(
      new BudgetGuard(providers, meterOf(100)).check('extraction', {
        subjectId: 'u',
      })
    ).resolves.toMatchObject({ allowed: false, remaining: 0 });
  });

  it('lets the more specific provider win', async () => {
    const guard = new BudgetGuard(
      [providerOf('env', 100), providerOf('stored', 500)],
      meterOf(200)
    );

    const decision = await guard.check('extraction', { subjectId: 'usr_1' });

    expect(decision).toMatchObject({
      allowed: true,
      limit: 500,
      source: 'stored',
    });
  });

  it('keeps earlier values when a later provider is unreachable', async () => {
    const onProviderError = vi.fn();
    const broken: IPolicyProvider = {
      source: 'stored',
      policyFor: () => Promise.reject(new Error('unreachable')),
    };
    const guard = new BudgetGuard(
      [providerOf('env', 100), broken],
      meterOf(50),
      {
        onProviderError,
      }
    );

    const decision = await guard.check('extraction', { subjectId: 'usr_1' });

    expect(decision).toMatchObject({
      allowed: true,
      limit: 100,
      source: 'env',
    });
    expect(onProviderError).toHaveBeenCalledWith('stored', expect.any(Error));
  });

  it('exempts calls made on the caller own credentials', async () => {
    const guard = new BudgetGuard([providerOf('env', 1)], meterOf(10_000));

    const decision = await guard.check('extraction', {
      subjectId: 'usr_1',
      usesCallerCredentials: true,
    });

    expect(decision).toMatchObject({
      allowed: true,
      limit: null,
      source: 'caller-credentials',
    });
  });

  it('records every decision, allowed or not', async () => {
    const seen: BudgetDecision[] = [];
    const guard = new BudgetGuard([providerOf('env', 10)], meterOf(10), {
      onDecision: (decision) => seen.push(decision),
    });

    await guard.check('extraction', { subjectId: 'usr_1' });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ allowed: false, spent: 10, limit: 10 });
  });

  it('raises a typed error rather than faking success', async () => {
    const guard = new BudgetGuard([providerOf('env', 10)], meterOf(10));

    await expect(
      guard.require('extraction', { subjectId: 'usr_1' })
    ).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it('does not raise for an unlimited budget however much was spent', async () => {
    const guard = new BudgetGuard([], meterOf(Number.MAX_SAFE_INTEGER));

    await expect(
      guard.require('maintenance', { subjectId: null })
    ).resolves.toMatchObject({ allowed: true });
  });
});

describe('EnvPolicyProvider', () => {
  it('reads a limit and a window for a budget', async () => {
    const provider = new EnvPolicyProvider({
      ZM_POLICY_EXTRACTION_LIMIT: '2000000',
      ZM_POLICY_EXTRACTION_WINDOW_DAYS: '7',
    });

    await expect(provider.policyFor('extraction')).resolves.toEqual({
      limit: 2_000_000,
      windowDays: 7,
    });
  });

  it('stays silent when the budget is not configured', async () => {
    const provider = new EnvPolicyProvider({});

    await expect(provider.policyFor('extraction')).resolves.toBeUndefined();
  });

  it.each(['', '   ', 'lots', '0', '-5', '1.5', '1e6x'])(
    'treats %j as not configured rather than as a limit',
    async (raw) => {
      const provider = new EnvPolicyProvider({
        ZM_POLICY_EXTRACTION_LIMIT: raw,
      });

      await expect(provider.policyFor('extraction')).resolves.toBeUndefined();
    }
  );

  it('does not let one budget leak into another', async () => {
    const provider = new EnvPolicyProvider({
      ZM_POLICY_EXTRACTION_LIMIT: '100',
    });

    await expect(provider.policyFor('translation')).resolves.toBeUndefined();
  });
});

describe('reporting is not deciding', () => {
  it('status never records a decision', async () => {
    const onDecision = vi.fn();
    const guard = new BudgetGuard([providerOf('env', 10)], meterOf(10), {
      onDecision,
    });

    await guard.status('extraction', { subjectId: 'usr_1' });

    expect(onDecision).not.toHaveBeenCalled();
  });

  it('status reports the same numbers check would', async () => {
    const guard = new BudgetGuard([providerOf('env', 10)], meterOf(4));

    const reported = await guard.status('extraction', { subjectId: 'usr_1' });
    const decided = await guard.check('extraction', { subjectId: 'usr_1' });

    expect(reported).toEqual(decided);
  });
});
