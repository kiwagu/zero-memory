import { setLlmGateway, type ILlmGateway } from '@workspace/llm';
import type { IUsageRecorder, UsageEvent } from '@workspace/usage';
import { beforeEach, describe, expect, it } from 'vitest';

import { LlmTranslator } from './llm.translator.js';

/**
 * Translation has to be metered as precisely as everything else it shares a
 * budget with: recorded against whoever the work was for, tagged with the
 * purpose, and marked when it ran on that person's own key. Without any one
 * of those the ledger and the guard stop describing the same thing.
 */
const gatewayReturning = (ranOnCallerKey: boolean): ILlmGateway => ({
  callTool: (request) =>
    Promise.resolve({
      input:
        request.purpose === 'translation'
          ? { text: 'hello', source_lang: 'ja' }
          : { faithful: true },
      model: 'a-model',
      inputTokens: 30,
      outputTokens: 12,
      ranOnCallerKey,
    }),
  searchWeb: () => Promise.reject(new Error('not used by translation')),
});

const collectingRecorder = () => {
  const events: UsageEvent[] = [];
  const recorder: IUsageRecorder = {
    record: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
  return { events, recorder };
};

/** Metering is fire-and-forget, so let the microtasks drain. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('translation is metered against its owner', () => {
  beforeEach(() => {
    setLlmGateway(gatewayReturning(false));
  });

  it('records both the translation and its faithfulness check', async () => {
    const { events, recorder } = collectingRecorder();

    await new LlmTranslator(recorder).translateToEnglish(
      'こんにちは',
      'usr_owner'
    );
    await settled();

    expect(events.map((event) => event.metadata?.['purpose'])).toEqual([
      'translation',
      'translation_faithfulness',
    ]);
    // Both are real spend on a real model; a judge call is not free.
    expect(events.every((event) => event.quantity === 42)).toBe(true);
  });

  it('attributes the rows to the owner the pass names', async () => {
    const { events, recorder } = collectingRecorder();

    await new LlmTranslator(recorder).translateToEnglish(
      'こんにちは',
      'usr_owner'
    );
    await settled();

    // The background pass has no ambient user, so naming the owner is the
    // only thing that keeps the row off the instance's ledger.
    expect(events.every((event) => event.subjectId === 'usr_owner')).toBe(true);
  });

  it('marks spend made on the owner own key', async () => {
    setLlmGateway(gatewayReturning(true));
    const { events, recorder } = collectingRecorder();

    await new LlmTranslator(recorder).translateToEnglish(
      'こんにちは',
      'usr_owner'
    );
    await settled();

    expect(events.every((event) => event.metadata?.['own_key'] === true)).toBe(
      true
    );
  });

  it('leaves platform-key spend unmarked, so it still counts', async () => {
    const { events, recorder } = collectingRecorder();

    await new LlmTranslator(recorder).translateToEnglish(
      'こんにちは',
      'usr_owner'
    );
    await settled();

    expect(
      events.every((event) => event.metadata?.['own_key'] === undefined)
    ).toBe(true);
  });

  it('still translates when nothing is there to meter', async () => {
    const result = await new LlmTranslator().translateToEnglish('こんにちは');

    expect(result.text).toBe('hello');
  });
});
