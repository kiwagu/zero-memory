-- Migration: widen the fusion candidate pool to k * 16 — measured, no trade-off
--
-- Purpose:
--   First accepted value through the new fusion_config knobs. On a clone of
--   the production corpus (2030 live memories), widening the per-leg pool
--   from k * 4 to k * 16 at the unchanged RRF constant cut the briefing junk
--   share 0.542 → 0.458 (13 → 11 junk rows) with an IDENTICAL present-hit
--   set (23/25) and MRR 0.931 → 0.935. Mechanism: the wider pool admits
--   legitimate mid-rank candidates into fusion and they displace junk from
--   the briefing pack slots.
--
-- Special considerations:
--   - Deliberately NOT combined with lowering rrf_k: the same evaluation
--     showed a sharpened constant costs legitimate briefing targets that a
--     wider pool does not recover (the miss sets at pool k*4/k*8/k*16 were
--     identical), and at a sharp constant a wide pool even re-admits junk.
--   - Cost is bounded: each leg reads at most k * 16 rows (192 at the
--     default k = 12) from an exact scan over ~2k live memories.
update public.fusion_config
set pool_multiplier = 16, updated_at = now();
