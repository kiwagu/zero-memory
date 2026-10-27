import { describe, expect, it } from 'vitest';

import { readJudgeConfig, readRuleGateConfig } from './judge-config.js';

describe('readJudgeConfig', () => {
  it('defaults to typesafe, jev-1.14.0 and a 1500 ms timeout', () => {
    const config = readJudgeConfig({});
    expect(config.provider).toBe('typesafe');
    expect(config.models.typesafe).toBe('jev-1.14.0');
    expect(config.timeoutMs).toBe(1500);
    expect(config.platformKeys).toEqual({});
  });

  it('reads the platform keys under their fixed names', () => {
    const config = readJudgeConfig({
      ZM_TYPESAFE_API_KEY: 'ts-key',
      ZM_SNAPQ_API_KEY: 'snap-key',
      ZM_JUDGE_PROVIDER: 'subq',
      ZM_JUDGE_MODEL_SUBQ: 'subq-snap-preview',
      ZM_JUDGE_TIMEOUT_MS: '900',
    });
    expect(config.provider).toBe('subq');
    expect(config.platformKeys).toEqual({
      typesafe: 'ts-key',
      subq: 'snap-key',
    });
    expect(config.models.subq).toBe('subq-snap-preview');
    expect(config.timeoutMs).toBe(900);
  });

  it('treats empty knobs as unset, as compose passes `${VAR:-}`', () => {
    expect(
      readJudgeConfig({
        ZM_JUDGE_PROVIDER: '',
        ZM_TYPESAFE_API_KEY: '',
        ZM_SNAPQ_API_KEY: '',
        ZM_JUDGE_MODEL_TYPESAFE: '',
        ZM_JUDGE_MODEL_SUBQ: '',
        ZM_JUDGE_TIMEOUT_MS: '',
      })
    ).toEqual(readJudgeConfig({}));
  });

  it('refuses an unknown provider name', () => {
    expect(() => readJudgeConfig({ ZM_JUDGE_PROVIDER: 'gpt' })).toThrow(
      /ZM_JUDGE_PROVIDER/
    );
  });
});

describe('readRuleGateConfig', () => {
  it('is off with 0.60 / 0.35 bands by default', () => {
    expect(readRuleGateConfig({})).toEqual({
      mode: 'off',
      hi: 0.6,
      lo: 0.35,
      timeoutMs: 1500,
      defaultProvider: 'typesafe',
      defaultModels: { typesafe: 'jev-1.14.0', subq: 'subq-snap-1.1' },
    });
  });

  it('treats empty knobs as unset, as compose passes `${VAR:-}`', () => {
    expect(
      readRuleGateConfig({
        ZM_RULE_GATE_MODE: '',
        ZM_RULE_GATE_HI: '',
        ZM_RULE_GATE_LO: '',
        ZM_JUDGE_TIMEOUT_MS: '',
      })
    ).toEqual(readRuleGateConfig({}));
  });

  it('refuses bands that are not ordered inside (0, 1)', () => {
    expect(() =>
      readRuleGateConfig({ ZM_RULE_GATE_HI: '0.2', ZM_RULE_GATE_LO: '0.5' })
    ).toThrow(/ZM_RULE_GATE_HI/);
    expect(() => readRuleGateConfig({ ZM_RULE_GATE_MODE: 'on' })).toThrow(
      /ZM_RULE_GATE_MODE/
    );
  });
});
