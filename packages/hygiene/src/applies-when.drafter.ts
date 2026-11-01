import { llmGateway } from '@workspace/llm';
import { z } from 'zod';

/** The same corrected-tuned model as the rule distiller, whose field this backfills. */
const DEFAULT_MODEL = 'claude-sonnet-5';
const TOOL = 'record_applies_when';

const POLICY = `
You read ONE standing rule an agent must follow. Write applies_when: one to
three short lines naming the OBSERVABLE features of a task for which this rule
binds — what a task description itself shows (which files or systems it
touches, what kind of work it is), never what will happen later in it.
Example: "any task that changes files tracked by git, including docs" rather
than "when committing". Always write one: a rule that binds every task says
so as its widest feature, for example "any task in any project".
Keep code, identifiers and paths verbatim. No preamble.`.trim();

const schema = z.object({
  applies_when: z.string().min(1).max(400),
});

/**
 * The model answered, but not with a usable condition. Unlike a model that is
 * not there to ask, this is a fault to surface, not a reason to go without.
 */
export class AppliesWhenDraftError extends Error {
  constructor(message: string) {
    super(`applies_when draft: ${message}`);
    this.name = 'AppliesWhenDraftError';
  }
}

export interface AppliesWhenDraft {
  applies_when: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** True when the call ran on the owner's own key, for metering. */
  ranOnCallerKey: boolean;
}

/**
 * Drafts the applicability line of a rule from its text: the condition the
 * rule gate judges a task against. Every promoted rule carries one, pinned or
 * not, so a rule that arrives without one gets it from here, for the owner to
 * review. Generation, so it stays on the LLM.
 */
export class AppliesWhenDrafter {
  async draft(ruleText: string, subjectId?: string): Promise<AppliesWhenDraft> {
    const model = process.env.ZM_HYGIENE_MODEL ?? DEFAULT_MODEL;
    const response = await llmGateway().callTool({
      model,
      maxOutputTokens: 300,
      system: POLICY,
      prompt: `Rule:\n${ruleText}`,
      tool: {
        name: TOOL,
        description: 'Record the applicability line of the rule.',
        inputSchema: z.toJSONSchema(schema, {
          target: 'draft-7',
        }) as Record<string, unknown>,
      },
      purpose: 'rule_distiller',
      ...(subjectId ? { subjectId } : {}),
    });
    const parsed = schema.safeParse(response.input);
    if (!parsed.success) {
      throw new AppliesWhenDraftError(parsed.error.message);
    }
    const condition = parsed.data.applies_when.trim();
    if (!condition) {
      throw new AppliesWhenDraftError('the model wrote no condition');
    }
    return {
      applies_when: condition,
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      ranOnCallerKey: response.ranOnCallerKey,
    };
  }
}
