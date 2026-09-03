/**
 * Looks up a transport session by id and enforces that it belongs to the
 * caller who created it. A session id belonging to another user must be
 * indistinguishable from one that was never issued at all, so a mismatch is
 * reported the same way as a miss: undefined, never a distinct signal.
 */

export interface OwnedSession {
  ownerUserEntityId: string;
}

export const sessionForOwner = <T extends OwnedSession>(
  sessions: Map<string, T>,
  sessionId: string,
  userEntityId: string
): T | undefined => {
  const session = sessions.get(sessionId);
  if (!session || session.ownerUserEntityId !== userEntityId) {
    return undefined;
  }
  return session;
};
