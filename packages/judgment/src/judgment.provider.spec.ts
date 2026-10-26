import { describe, expect, it } from 'vitest';

import { defaultJudgmentFactory } from './judgment.provider.js';
import { SubqJudgment } from './subq.adapter.js';
import { TypeSafeJudgment } from './typesafe.adapter.js';

describe('defaultJudgmentFactory', () => {
  it('builds the adapter the credential names', () => {
    expect(
      defaultJudgmentFactory({
        provider: 'typesafe',
        apiKey: 'k',
        model: 'jev-1.14.0',
        ownedByCaller: false,
      })
    ).toBeInstanceOf(TypeSafeJudgment);
    expect(
      defaultJudgmentFactory({
        provider: 'subq',
        apiKey: 'k',
        model: 'subq-snap-1.1',
        ownedByCaller: true,
      })
    ).toBeInstanceOf(SubqJudgment);
  });
});
