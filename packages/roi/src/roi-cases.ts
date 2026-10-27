import type { RoiProbeRow } from './roi-runner.js';
import type { RoiProbeCase } from './roi.schema.js';

/** What one probe's recall surfaced, by memory id, in rank order. */
export interface RoiRecalledIds {
  probeId: string;
  surfacedIds: string[];
}

/**
 * The cases a recall phase collected, rebuilt from ids alone: the question and
 * ground truth from the probe, each surfaced memory's content from `contents`.
 * The recall picked the ids under the caller's own access rules, so this
 * shows the judge nothing that recall did not. A probe retired since is left
 * out, and so is a case one of whose surfaced memories is gone since: judged
 * on partial evidence it could record a miss recall never made.
 */
export const rebuildRoiCases = (
  probes: readonly RoiProbeRow[],
  contents: ReadonlyMap<string, string>,
  recalled: readonly RoiRecalledIds[]
): RoiProbeCase[] => {
  const byId = new Map(probes.map((probe) => [probe.probeId, probe]));
  return recalled.flatMap(({ probeId, surfacedIds }) => {
    const probe = byId.get(probeId);
    if (!probe || surfacedIds.some((id) => !contents.has(id))) {
      return [];
    }
    return [
      {
        probeId,
        question: probe.question,
        groundTruthId: probe.groundTruthId,
        groundTruth: probe.groundTruth,
        surfaced: surfacedIds.map((id) => ({
          id,
          content: contents.get(id) ?? '',
        })),
      },
    ];
  });
};
