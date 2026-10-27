import type * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  JudgeProviderPanel,
  type JudgeProviderLabels,
  type JudgeProviderState,
} from '@workspace/ui/components/settings/judge-provider-panel';

// Static markup has no DOM to click, so the switch is wrapped to hand its
// change handler back to the test: calling it is what a click on the switch
// does. The real switch still renders, so its markup is what is asserted.
const switches = vi.hoisted(() => ({
  props: [] as {
    'data-testid'?: string;
    onCheckedChange?: (checked: boolean) => void;
  }[],
}));

vi.mock(
  '@workspace/ui/components/switch',
  async (importOriginal: () => Promise<{ Switch: React.FC<object> }>) => {
    const actual = await importOriginal();
    return {
      Switch: (props: (typeof switches.props)[number]) => {
        switches.props.push(props);
        return <actual.Switch {...props} />;
      },
    };
  }
);

const labels: JudgeProviderLabels = {
  title: 'Rule delivery judge',
  description: 'Let a small decision model pick.',
  enable: 'Judge my standing rules per call',
  provider: 'Provider',
  providerDefault: 'Instance default ({provider})',
  key: 'Your own key (optional)',
  keyPlaceholder: 'Paste your key',
  model: 'Model (optional)',
  modelPlaceholder: 'Provider default',
  save: 'Save',
  saving: 'Saving…',
  installed: 'A {provider} key ending {hint} is installed; judging runs on it.',
  revoke: 'Revoke key',
  revoking: 'Revoking…',
  statusPlatform: 'Judging runs on the instance key.',
  statusOff: 'Off: every rule arrives in full.',
  hint: 'Stored keys are encrypted and never displayed.',
};

const off: JudgeProviderState = {
  enabled: false,
  provider: null,
  platformDefault: 'typesafe',
  credential: null,
  subqAvailable: true,
};

const ok = async () => ({ ok: true as const });

const render = (
  current: JudgeProviderState,
  onSettings: Parameters<typeof JudgeProviderPanel>[0]['onSettings'] = ok
) =>
  renderToStaticMarkup(
    <JudgeProviderPanel
      labels={labels}
      current={current}
      onSettings={onSettings}
      onSaveKey={ok}
      onRevokeKey={ok}
    />
  );

const tagOf = (html: string, testId: string) =>
  new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0];

const optionValues = (html: string, testId: string) => {
  const select = new RegExp(
    `<select[^>]*data-testid="${testId}"[^>]*>(.*?)</select>`
  ).exec(html)?.[1];
  return [...(select ?? '').matchAll(/<option value="([^"]*)"/g)].map(
    (match) => match[1]
  );
};

beforeEach(() => {
  switches.props.length = 0;
});

describe('JudgeProviderPanel', () => {
  it('starts off: the switch is unchecked and the status says every rule arrives in full', () => {
    const html = render(off);
    expect(tagOf(html, 'settings-judge-enable')).toContain(
      'aria-checked="false"'
    );
    expect(html).toContain('data-testid="settings-judge-status"');
    expect(html).toContain('Off: every rule arrives in full.');
    expect(html).not.toContain('Judging runs on the instance key.');
  });

  it('turns judging on with the provider left to the instance default', async () => {
    const onSettings = vi.fn(ok);
    render(off, onSettings);
    const toggle = switches.props.find(
      (props) => props['data-testid'] === 'settings-judge-enable'
    );
    expect(toggle?.onCheckedChange).toBeTypeOf('function');

    toggle!.onCheckedChange!(true);

    await vi.waitFor(() =>
      expect(onSettings).toHaveBeenCalledWith({ enabled: true, provider: null })
    );
  });

  it('offers SubQ Snap only when this build can run it', () => {
    const withSubq = render(off);
    expect(optionValues(withSubq, 'settings-judge-provider-select')).toEqual([
      '',
      'typesafe',
      'subq',
    ]);
    expect(withSubq).toContain('Instance default (TypeSafe Jev)');

    const without = render({ ...off, subqAvailable: false });
    expect(optionValues(without, 'settings-judge-provider-select')).toEqual([
      '',
      'typesafe',
    ]);
    expect(optionValues(without, 'settings-judge-key-provider')).toEqual([
      'typesafe',
    ]);
    expect(without).not.toContain('SubQ Snap');
  });

  it('names an installed key by its provider and last four characters only', () => {
    const html = render({
      ...off,
      enabled: true,
      credential: { provider: 'typesafe', hint: 'ab12', model: null },
    });
    expect(html).toContain('data-testid="settings-judge-installed"');
    expect(html).toContain(
      'A TypeSafe Jev key ending ab12 is installed; judging runs on it.'
    );
    expect(html).toContain('data-testid="settings-judge-revoke"');
    // The key field stays empty: nothing here can render a stored key.
    expect(tagOf(html, 'settings-judge-key-input')).toContain('value=""');
  });
});
