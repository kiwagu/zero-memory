-- Migration: a stored consent names the return address it was given for
--
-- Purpose:
--   A person who allowed an OAuth client once is not asked again when that
--   client returns: the server finds their consent and sends the browser on
--   with a code, no screen. The consent was keyed by person and client only.
--   A client may register several return addresses, and the address shown on
--   the consent screen ("you will be sent back to …") is what tells a genuine
--   client from one that merely took its name. Remembering the approval for
--   the whole client stretched one look at one address over every address the
--   client registered.
--
--   The consent now records the return address the person approved, and the
--   screen is skipped only for a request that returns there (a loopback
--   address compares without its port, as registration does: native clients
--   bind a fresh port each time). A request for another registered address
--   asks again, and the new approval replaces the recorded address.
--
-- Affected objects:
--   - table public.oauth_consents: column redirect_uri (new, nullable)
--
-- Special considerations:
--   - Consents recorded before this column existed have no address. They
--     cover no request: each such client asks once more, and the address is
--     recorded with that approval. Nothing is lost beyond one screen.
--   - Still one live consent per person and client. Approving a second
--     address of the same client replaces the first; a client with two
--     addresses in regular use is asked whenever it alternates.

alter table public.oauth_consents
  add column redirect_uri text;

comment on column public.oauth_consents.redirect_uri is
  'The return address the person saw when approving. A repeat authorization '
  'skips the screen only when it returns there (loopback compared without the '
  'port). Null on a consent recorded before addresses were kept: it covers no '
  'request, so the client asks once more.';

comment on table public.oauth_consents is
  'Which OAuth clients each person has approved, for which scope and to which '
  'return address. A live consent lets a repeat authorization of the same '
  'client to the same address skip the screen. Deny-all RLS: service-role '
  'access only.';
