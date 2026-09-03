/**
 * The origin the browser actually sees. Behind the edge proxy Next's own
 * `request.nextUrl.origin` resolves to the internal bind address (e.g.
 * `https://0.0.0.0:3100`), so an absolute redirect built from it sends the
 * user to a host that exists only inside the deployment. The proxy forwards
 * the real origin in `X-Forwarded-Host` / `X-Forwarded-Proto`; without a
 * proxy (dev, e2e) those headers are absent and the request origin is
 * already the external one.
 */
export const externalOrigin = (request: {
  headers: Headers;
  nextUrl: { origin: string };
}): string => {
  const host = request.headers.get('x-forwarded-host');
  if (!host) {
    return request.nextUrl.origin;
  }
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  return `${proto}://${host}`;
};
