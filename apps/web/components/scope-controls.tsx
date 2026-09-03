'use client';

import { useRouter } from 'next/navigation';

import {
  ScopeControls as ScopeControlsUi,
  type MergeTargetOption,
  type ScopeControlsLabels,
} from '@workspace/ui/components/scope/scope-controls';

import {
  deleteScope,
  mergeScopes,
  renameScope,
  saveScopeMeta,
  type ActionResult,
} from '@/lib/actions';
import { generateScopeDescription } from '@/lib/scope-describe-action';

/** Wires the scope admin menu to the server actions + a refresh on success. */
export function ScopeControls({
  scope,
  alias,
  description,
  mergeTargets,
  labels,
}: {
  scope: string;
  alias: string | null;
  description: string | null;
  mergeTargets: MergeTargetOption[];
  labels: ScopeControlsLabels;
}) {
  const router = useRouter();

  async function apply(result: Promise<ActionResult>): Promise<string | null> {
    const outcome = await result;
    if (!outcome.ok) {
      return outcome.error;
    }
    router.refresh();
    return null;
  }

  return (
    <ScopeControlsUi
      scope={scope}
      alias={alias}
      description={description}
      mergeTargets={mergeTargets}
      labels={labels}
      handlers={{
        saveMeta: (nextAlias, nextDescription) =>
          apply(saveScopeMeta(scope, nextAlias, nextDescription)),
        rename: (slug) => apply(renameScope(scope, slug)),
        merge: (into) => apply(mergeScopes(scope, into)),
        remove: () => apply(deleteScope(scope)),
        generateDescription: async () => {
          const result = await generateScopeDescription(scope);
          return result.ok
            ? { description: result.description }
            : { error: result.error };
        },
      }}
    />
  );
}
