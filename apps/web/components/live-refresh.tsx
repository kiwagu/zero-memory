import {
  LiveRefreshListener,
  type LiveRefreshEvent,
} from '@/components/live-refresh.client';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { currentUserEntityId } from '@/lib/user';

/**
 * Keeps a page current while agents work: the page refreshes whenever the
 * store tells its reader that `event`'s data changed. Renders nothing.
 */
export async function LiveRefresh({ event }: { event: LiveRefreshEvent }) {
  const readerId = await currentUserEntityId(
    await createServerSupabaseClient()
  );
  return readerId ? (
    <LiveRefreshListener readerId={readerId} event={event} />
  ) : null;
}
