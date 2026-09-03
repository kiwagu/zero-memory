import { EMBEDDING_WINDOW_CHARS } from '@workspace/embedding';

/**
 * What a writer is told when a memory outgrew the model's input window.
 *
 * WHY THIS EXISTS AT ALL, since the obvious objection is that a long memory
 * now works fine: it does, and that is precisely the problem. Retrieval used
 * to punish length silently — everything past the window simply never entered
 * the vector — and that penalty has been removed, so nothing about length is
 * visible at the moment of writing any more. Meanwhile the reasons to stay
 * short survive: a briefing inlines only the first 2400 characters of a memory
 * and 400 of an open loop, a record cannot be superseded in halves, and a
 * record searchable from every angle also matches queries it is only
 * marginally about.
 *
 * WHY IMPERATIVE RATHER THAN ADVISORY: this project has measured the polite
 * version losing. The wording therefore states what the write already cost and
 * instructs the next one, in that order — a report of something that happened
 * is harder to skim past than a request for something that has not.
 *
 * WHY NOT A REFUSAL, decided 2026-08-20: a ceiling strict enough to move the
 * mean would have to sit near 2000 characters, which is exactly where handover
 * notes live, and machine-splitting the text produces fragments rather than
 * atoms — a paragraph that only makes sense after the one before it is not a
 * standalone fact. Where to cut is the writer's judgement; this is what puts
 * the question in front of them.
 */
export const oversizeDirective = (
  contentChars: number,
  overflowWindows: number
): string =>
  `This memory is ${contentChars} characters and did not fit the embedding ` +
  `model's input window; covering it took ${overflowWindows + 1} windows. ` +
  `Keep the next one to ONE durable fact within about ` +
  `${EMBEDDING_WINDOW_CHARS} characters, and split longer knowledge into ` +
  `separate linked memories rather than one long record. Length is no longer ` +
  `punished by search, but a briefing still inlines only the first 2400 ` +
  `characters of a memory and 400 of an open loop, and a record this size ` +
  `cannot be superseded in halves — so the part you write past the window is ` +
  `paid for on every read and cannot be corrected on its own.`;
