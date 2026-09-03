# @workspace/roi

The counterfactual ROI benchmark: "what would your agent lose without
memory?". Holdout questions (probes) are derived from the owner's own
memories; a run recalls each question and judges two arms — did the surfaced
facts answer it (WITH memory), and could a competent agent have answered from
general knowledge alone (WITHOUT). The headline is the exclusive rate:
questions only memory could answer.

- `RoiProber` — generates probes from owned memories (LLM forced-tool; a
  deterministic template variant keeps key-free runs working).
- `RoiJudge` — judges one probe against the facts a real recall surfaced
  (deterministic variant: ground-truth id surfaced = WITH, WITHOUT = false).
- `RoiRunner` — service-role orchestration: probe top-up/retirement, judging,
  result rows; judge tokens are metered as `llm_extraction`
  (`purpose: roi_probe`).

Recall itself never runs here: it happens in the caller's authenticated
context (RLS-honest), and the surfaced facts are handed in.
