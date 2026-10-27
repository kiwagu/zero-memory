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
than "when committing". Answer null when the rule binds every task.
Keep code, identifiers and paths verbatim. No preamble.`.trim();

const schema = z.object({
  applies_when: z.string().max(400).nullable(),
});

export interface AppliesWhenDraft {
  applies_when: string | null;
  model: string;
}

/**
 * Drafts the applicability line of an existing rule from its text: the
 * condition the rule gate judges a task against. Rules promoted before the
 * distiller wrote one get it from here, for the owner to review. Generation,
 * so it stays on the LLM.
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
    const parsed = schema.parse(response.input);
    return {
      applies_when: parsed.applies_when?.trim() || null,
      model: response.model,
    };
  }
}
