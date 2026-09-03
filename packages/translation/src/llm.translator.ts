import { llmGateway } from '@workspace/llm';
import { singleton } from '@workspace/di';
import { createLogger } from '@workspace/logger';
import {
  injectUsageRecorder,
  recordUsage,
  type IUsageRecorder,
} from '@workspace/usage';

import type { ITranslator, TranslationResult } from '@workspace/memory';

// Sonnet by default: with born-English authoring the translator is a rarely
// used fallback, so per-call quality outweighs cost. ZM_TRANSLATOR_MODEL
// overrides (e.g. back to a Haiku-class model for bulk migrations).
const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_OUTPUT_TOKENS = 2048;
const RECORD_TOOL_NAME = 'provide_translation';
const VERDICT_TOOL_NAME = 'verify_translation';

const FAITHFULNESS_POLICY = `
You judge whether an English rendering of a stored technical "memory"
preserves the meaning of its original. Check that no facts, qualifiers,
hedging, or nuance were dropped, added, or shifted, and that code,
identifiers, and quoted terms survived verbatim. Minor wording differences
are fine — meaning drift is not.`.trim();

/** Judge tool schema (hand-written to avoid a zod dependency here). */
const VERDICT_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    faithful: {
      type: 'boolean',
      description: 'True when the English preserves the full meaning.',
    },
    drift: {
      type: 'string',
      description:
        'When not faithful: a one-sentence description of what drifted.',
    },
  },
  required: ['faithful'],
};

const TRANSLATION_POLICY = `
You translate a single stored "memory" — a self-contained technical fact,
decision, convention, or gotcha from a software project — into English, and
report the language it was originally written in.

Rules:
- Put ONLY the English translation in \`text\`. No preamble, notes, or quotes.
- Preserve meaning exactly, including nuance and hedging. Do not summarize,
  expand, or editorialize.
- Keep code, identifiers, file paths, commands, URLs, product/library names,
  and already-English technical terms VERBATIM — translate the prose around
  them, not them.
- If the text is already entirely English, return it unchanged and set
  \`source_lang\` to "en".
- \`source_lang\` is a short BCP-47-ish code of the ORIGINAL language, e.g.
  "en", "es", "ja", "zh".`.trim();

/** Tool input schema (hand-written to avoid a zod dependency here). */
const TRANSLATION_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'The English translation, and nothing else.',
    },
    source_lang: {
      type: 'string',
      description:
        'Short code of the original language, e.g. "en", "es", "ja".',
    },
  },
  required: ['text', 'source_lang'],
};

/**
 * Model-backed adapter for the translator port: one forced-tool-use call to
 * translate, then a second independent call that JUDGES faithfulness — an
 * unfaithful rendering is refused (throw), so the caller's failure path
 * leaves the row pending with the drift recorded instead of persisting a
 * meaning-shifted translation. Off the hot write path (only the
 * write-triggered hook and the backstop worker call this). The client is
 * created lazily so the package imports without an API key.
 */
@singleton()
export class LlmTranslator implements ITranslator {
  readonly #logger = createLogger('LlmTranslator');

  /**
   * The recorder is optional because this class is also built by hand — the
   * scheduled pass constructs it directly rather than through the container.
   * Without one the work still happens; it simply is not metered, which is
   * the right failure for a smoke stack and the wrong one for a server, so
   * both real construction sites pass one.
   */
  constructor(
    @injectUsageRecorder()
    private readonly usage?: IUsageRecorder
  ) {}

  /** Records one call's tokens against whoever the work was for. */
  #meter(
    purpose: 'translation' | 'translation_faithfulness',
    model: string,
    response: {
      inputTokens: number;
      outputTokens: number;
      ranOnCallerKey: boolean;
    },
    ownerId?: string
  ): void {
    if (!this.usage) return;
    recordUsage(this.usage, {
      eventType: 'llm_extraction',
      quantity: response.inputTokens + response.outputTokens,
      unit: 'tokens',
      ...(ownerId === undefined ? {} : { subjectId: ownerId }),
      metadata: {
        purpose,
        model,
        input_tokens: response.inputTokens,
        output_tokens: response.outputTokens,
        // Spend on the caller's own key is theirs, not the platform's.
        ...(response.ranOnCallerKey ? { own_key: true } : {}),
      },
    });
  }

  async translateToEnglish(
    text: string,
    ownerId?: string
  ): Promise<TranslationResult> {
    const model = process.env.ZM_TRANSLATOR_MODEL ?? DEFAULT_MODEL;
    const response = await llmGateway().callTool({
      model,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      system: TRANSLATION_POLICY,
      prompt: text,
      tool: {
        name: RECORD_TOOL_NAME,
        description: 'Return the English translation and the source language.',
        inputSchema: TRANSLATION_TOOL_SCHEMA,
      },
      purpose: 'translation',
      ...(ownerId === undefined ? {} : { subjectId: ownerId }),
    });
    this.#meter('translation', model, response, ownerId);

    const input = response.input as { text?: unknown; source_lang?: unknown };
    const translated = typeof input.text === 'string' ? input.text.trim() : '';
    if (translated.length === 0) {
      throw new Error('Translator returned an empty translation.');
    }
    const sourceLang =
      typeof input.source_lang === 'string' && input.source_lang.trim()
        ? input.source_lang.trim().toLowerCase()
        : 'und';

    // Faithfulness gate: judge every ACTUAL translation (skipped when the
    // text came back as already-English). Refusing here keeps the original
    // untouched and routes the drift into the existing pending/retry path.
    if (sourceLang !== 'en') {
      await this.#assertFaithful(model, text, translated, ownerId);
    }

    this.#logger.debug('translated memory', {
      model,
      sourceLang,
      inChars: text.length,
      outChars: translated.length,
    });
    return { text: translated, sourceLang };
  }

  /** Second, independent judge call; throws when the meaning drifted. */
  async #assertFaithful(
    model: string,
    original: string,
    translated: string,
    ownerId?: string
  ): Promise<void> {
    const response = await llmGateway().callTool({
      model,
      maxOutputTokens: 512,
      system: FAITHFULNESS_POLICY,
      prompt: `ORIGINAL:\n${original}\n\nENGLISH RENDERING:\n${translated}`,
      tool: {
        name: VERDICT_TOOL_NAME,
        description: 'Report whether the rendering preserves the meaning.',
        inputSchema: VERDICT_TOOL_SCHEMA,
      },
      purpose: 'translation_faithfulness',
      ...(ownerId === undefined ? {} : { subjectId: ownerId }),
    });
    this.#meter('translation_faithfulness', model, response, ownerId);
    const verdict = response.input as { faithful?: unknown; drift?: unknown };
    if (verdict.faithful !== true) {
      const drift =
        typeof verdict.drift === 'string' && verdict.drift.trim()
          ? verdict.drift.trim()
          : 'unspecified meaning drift';
      throw new Error(`Unfaithful translation: ${drift}`);
    }
  }
}
