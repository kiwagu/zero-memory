import type {
  CardEventId,
  CardNoteRelation,
  CardRef,
  CardState,
  MemoryId,
} from '@workspace/contracts';

/**
 * What the aggregate raises when a card changes.
 *
 * A draft carries only what the DOMAIN knows. Identity, position in the
 * stream, actor, thread and timestamp are stamped by the store when the event
 * is appended, so nothing here can invent them.
 */
export type CardEventDraft =
  | {
      type: 'created';
      toState: CardState;
      originLoopId: MemoryId | null;
    }
  | { type: 'edited'; revision: number }
  | { type: 'moved'; fromState: CardState; toState: CardState; reason: string }
  | { type: 'archived'; reason: string }
  | { type: 'attached'; ref: CardRef }
  | { type: 'detached'; ref: CardRef }
  | {
      type: 'noted';
      text: string;
      replyTo: CardEventId | null;
      relation: CardNoteRelation | null;
    };
