import { z } from 'zod';

import { entityIdSchemas } from './entity-prefixes.js';

/**
 * A user identity as the domain sees it: a branded `usr_` entity id
 * (`public.profiles.id`), our own 1:1 mirror of the external `auth.users.id`
 * (Supabase). The domain carries `usr_`; the DB/RLS keep the auth uuid.
 */
export const userIdSchema = entityIdSchemas.user.schema;
export type UserId = z.infer<typeof userIdSchema>;
