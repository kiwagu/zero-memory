/**
 * The supersede aperture: how the store decides which live memories to put in
 * front of a writer as possible predecessors of what they just wrote.
 *
 * It is a FLOOR PLUS A RANK CAP, not a similarity band, and the two constants
 * do different jobs. It lives in its own module because two paths must use the
 * SAME aperture, and a number copied into the second one would drift: the
 * write path offers the candidates in the `remember` response, and the retro
 * pass sweeps history with the identical opening so a pair the write path
 * never got a verdict on is still found later.
 *
 * WHY NOT A BAND. The aperture used to be the half-open window [0.88, 0.92):
 * quiet, and measurably too narrow. Against 1433 ground-truth pairs — every
 * declared supersedes/contradicts edge in a real corpus, each one a case of
 * "when this row was written, that older row should have been surfaced" — the
 * window surfaced 29.2% of the true partners. 41.6% of them fell below the
 * floor; another 25.1% sat above the ceiling and were seen by nothing at all,
 * because the automatic collapse that supposedly owns that zone only fires for
 * a near-verbatim restatement written in the SAME session. A cosine window
 * cannot key what a memory is ABOUT: both of its edges cut through genuine
 * predecessors.
 *
 * WHAT THE FLOOR IS FOR, now that it is not the attention guard: a sparse or
 * brand-new store may hold nothing genuinely related, and a bare rank cap
 * would answer with the nearest unrelated rows. 0.80 keeps 1432 of the 1433
 * true partners (0.88 keeps 58.4%, which caps coverage no matter how many
 * candidates are shown). In a store of any size it is effectively inert.
 *
 * WHAT THE CAP IS FOR: it bounds attention, over rows ordered by distance.
 * Coverage of the true partner by rank is 82.3% at 5, 90.6% at 10 and 96.4%
 * at 20, and the marginal value dies after 10 while the cost does not —
 * because the floor is inert, the cap is always filled, so this number is
 * literally how many stubs a writer reads on every write. 10 buys nine tenths
 * of the value at half the attention of 20; the rest is the retro pass's job,
 * where the cost is machine time rather than someone's attention.
 *
 * HONEST LIMIT of every number above: they are measured on pairs that writers
 * DID declare, so they say "would have been shown what was already found".
 * Genuinely missed pairs are unlabelled by construction and stay unmeasured.
 */

/** Cosine floor of the aperture — a sparse-store guard, not an attention one. */
export const SUPERSEDE_APERTURE_FLOOR = 0.8;

/** How many candidates a writer is shown; what actually bounds attention. */
export const SUPERSEDE_APERTURE_CAP = 10;

/**
 * How many rows the probe fetches before filtering. Over-fetches so provably
 * cross-project pairs (and the row just written) can be dropped and the cap
 * still filled.
 */
export const SUPERSEDE_PROBE_LIMIT = 24;

/**
 * The retro pass opens the same aperture WIDER BY RANK and NARROWER BY
 * SIMILARITY than the write path, and the asymmetry is what a real sweep
 * taught rather than what the design predicted.
 *
 * The CAP can afford to be wider: on the write path it is paid in the writer's
 * attention, one glance per write, while here it costs a queue row someone
 * skims later. 20 is the measured population width — 96.4% of true partners —
 * and it is what makes the narrower write-path cap safe to choose: the tail the
 * writer is not shown is not lost, it is collected here. Wider than 20 is not
 * worth it (2.7 points to 50, another 0.6 to 100) — the queue dies of noise
 * long before it dies of incompleteness.
 *
 * The FLOOR has to be HIGHER than the write path's, and this is the
 * counter-intuitive half. A low floor sounds free because it only widens what
 * is considered — but with a rank cap the cap is ALWAYS FILLED, so a low floor
 * does not add candidates only when they exist, it guarantees the full quota of
 * them for every subject whether or not a real partner is there. Judging a
 * whole batch by hand made the price visible: of 135 pairs, the zone below 0.88
 * was 131 pairs and ONE useful finding, while the zone above the retired
 * ceiling was 2 pairs and 2 findings. Same corpus, same sweep, a 130x
 * difference in yield.
 *
 * 0.88 is where the useful pairs actually live, measured rather than assumed:
 * the reference case this whole aperture was designed around sits at 0.890,
 * 0.892, 0.899 and 0.905 — every one of its rows above this floor. That case
 * was never blocked by a floor; it was blocked by a cap of 3, which is what the
 * wider cap above fixes.
 *
 * The write path keeps its lower floor deliberately: there the cap binds first
 * (a dense store holds more neighbours above 0.88 than the cap shows anyway),
 * the floor only guards a sparse or brand-new store, and the reader is the
 * author — the best-placed judge there will ever be for that pair.
 */
export const RETRO_APERTURE_CAP = 20;

/** See above: higher than the write path's floor, and measured, not assumed. */
export const RETRO_APERTURE_FLOOR = 0.88;
