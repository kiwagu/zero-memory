-- Migration: an `unjudged` class for the review queue
--
-- Purpose:
--   Until now every pair row in the queue arrived with a verdict a
--   server-side LLM judge had already reached — the queue was where the judge
--   put what it could not settle. The retro pass over the memory backlog adds
--   a second producer that reaches no verdict at all: it opens the same
--   aperture the write path uses, over history instead of the last few days,
--   and hands each pair to the READER to adjudicate.
--
--   The reason it does not judge is economics, and it is the same reason the
--   write path does not: a server-side judge spends the operator's model
--   budget on every pair, so cost grows with corpus size while nothing about
--   the value does. The session agent that reads the queue is already paid
--   for by whoever runs it, sees more context than a server judge ever could,
--   and is the party that can act on the answer. So the server generates
--   candidate pairs deterministically (vector distance and SQL, no model) and
--   the reader decides — the same division of labour the write-time candidate
--   hint already uses.
--
--   `unjudged` is therefore a genuine class, not a placeholder: it tells the
--   reader "these two were put in front of you because they are near
--   neighbours, and nobody has formed an opinion yet". Confidence and
--   rationale are null for these rows, which is honest — there is no
--   judgement to describe. Resolving one needs nothing new: `winner` (the
--   other side is reversibly superseded) or keep-both (dismiss) already carry
--   both outcomes.
--
-- Affected objects:
--   - constraint: public.memory_review_queue_verdict_check (drop + recreate,
--     widening the allowed set — no row can violate the wider version)
--
-- Special considerations:
--   - The companion `memory_review_queue_subject_shape` check needs no change:
--     it ties a null `memory_b` to the single-subject verdicts, and `unjudged`
--     is a PAIR verdict, so it keeps both sides exactly as the check requires.
--   - Widening a CHECK is safe on existing data by construction: every stored
--     verdict already satisfies the narrower set.

set search_path = public;

alter table public.memory_review_queue
  drop constraint if exists memory_review_queue_verdict_check;

alter table public.memory_review_queue
  add constraint memory_review_queue_verdict_check
  check (
    verdict in (
      'duplicate',
      'supersedes',
      'contradiction',
      'stale_suspect',
      'challenged',
      'unjudged'
    )
  );

comment on column public.memory_review_queue.verdict is
  'Dispute class. duplicate/supersedes/contradiction are a judge''s pair '
  'verdicts; stale_suspect/challenged are single-subject disputes whose '
  'memory_b is null; unjudged is a pair the retro aperture surfaced with no '
  'opinion attached, for the reader to adjudicate (confidence and rationale '
  'are null on those rows).';
