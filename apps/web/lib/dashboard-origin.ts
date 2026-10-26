import { NextResponse, type NextRequest } from 'next/server';

/**
 * Only the dashboard's own page may ask, and a change arrives as JSON. Every
 * current browser marks where a request comes from, and a missing mark is
 * refused as well: a same-site sibling origin would otherwise carry the
 * session cookie here, and a plain form post can carry a JSON-shaped body as
 * text. The settings routes that write keys and choices share this check;
 * account deletion makes the same one.
 */
export const notFromDashboard = (
  request: NextRequest,
  withBody: boolean
): boolean => {
  if (request.headers.get('sec-fetch-site') !== 'same-origin') {
    return true;
  }
  if (!withBody) {
    return false;
  }
  const type = request.headers.get('content-type') ?? '';
  return !type.toLowerCase().startsWith('application/json');
};

export const refusedOrigin = () =>
  NextResponse.json(
    { error: 'Refused: not sent from the dashboard.' },
    { status: 403 }
  );
