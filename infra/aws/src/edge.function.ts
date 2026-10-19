import {
  SecretValue,
  aws_cloudfront as cloudfront,
  type aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/**
 * The value CloudFront sends in `x-origin-verify`, read from the app's
 * environment secret when the stack deploys. Pinned to the secret version the
 * deploy stamps into the function: a changed secret then changes the
 * distribution too, instead of leaving the edge with the old value while new
 * instances expect the new one. Without a version (a first deploy) the
 * current one.
 */
export const edgeHeaderValue = (
  secret: secretsmanager.ISecret,
  version: string | undefined
): string =>
  SecretValue.secretsManager(secret.secretArn, {
    jsonField: 'ZM_ORIGIN_VERIFY',
    ...(version ? { versionId: version } : {}),
  }).unsafeUnwrap();

/**
 * Cookie bytes past which the viewer-request function clears the browser's
 * Supabase session cookies. A function URL refuses a request whose headers
 * exceed about 10 KB, with a 413 that blames a 6 MB body, and the function
 * never runs. One session's cookies stay well under this; a browser that
 * kept another project's session too (an instance that moved between
 * projects) can carry both and pass it.
 */
export const COOKIE_BUDGET = 8192;

/**
 * Source of the viewer-request function every distribution of this app runs
 * (CloudFront Functions, JavaScript runtime 2.0). It names, in headers of its
 * own, what only CloudFront knows for sure, overwriting any value a client
 * sent under the same names:
 *
 * - `x-viewer-address`: the address the request came from. CloudFront
 *   forwards a client's own X-Forwarded-For with the real address appended,
 *   so that header's first hop is whatever the client wrote;
 * - `x-forwarded-host`: the host name the browser used. The origin sees the
 *   function URL's own name as Host, and Next.js compares the browser's
 *   Origin with the forwarded host before it runs a Server Action.
 *
 * When the request's cookies pass COOKIE_BUDGET and include Supabase session
 * cookies (`sb-…`), it answers at the edge instead: a 303 back to the same
 * address that expires every one of them, so the browser returns with a
 * request the origin accepts and the person signs in again. Without it the
 * function URL refuses that browser on every request until its cookies are
 * cleared by hand. The query string arrives split into fields whose names
 * and values are still percent-encoded as the browser sent them, so they are
 * joined back as they are.
 */
export const VIEWER_REQUEST_SOURCE = [
  `var COOKIE_BUDGET = ${COOKIE_BUDGET};`,
  'function handler(event) {',
  '  var request = event.request;',
  '  var headers = request.headers;',
  "  headers['x-viewer-address'] = { value: event.viewer.ip };",
  "  headers['x-forwarded-host'] = { value: headers.host.value };",
  '  var size = 0;',
  '  var sessions = [];',
  '  for (var name in request.cookies) {',
  '    var cookie = request.cookies[name];',
  '    var values = cookie.multiValue || [cookie];',
  '    for (var i = 0; i < values.length; i++) {',
  '      size += name.length + values[i].value.length + 3;',
  '    }',
  "    if (name.indexOf('sb-') === 0) {",
  '      sessions.push(name);',
  '    }',
  '  }',
  '  if (size <= COOKIE_BUDGET || sessions.length === 0) {',
  '    return request;',
  '  }',
  '  var query = [];',
  '  for (var key in request.querystring) {',
  '    var param = request.querystring[key];',
  '    var items = param.multiValue || [param];',
  '    for (var j = 0; j < items.length; j++) {',
  "      query.push(key + '=' + items[j].value);",
  '    }',
  '  }',
  '  var expired = {};',
  '  for (var k = 0; k < sessions.length; k++) {',
  "    expired[sessions[k]] = { value: '', attributes: 'Path=/; Max-Age=0; Secure; SameSite=Lax' };",
  '  }',
  '  return {',
  '    statusCode: 303,',
  "    statusDescription: 'See Other',",
  '    headers: {',
  "      location: { value: request.uri + (query.length ? '?' + query.join('&') : '') },",
  "      'cache-control': { value: 'no-store' },",
  '    },',
  '    cookies: expired,',
  '  };',
  '}',
].join('\n');

export const viewerRequestFunction = (
  scope: Construct,
  id: string
): cloudfront.Function =>
  new cloudfront.Function(scope, id, {
    runtime: cloudfront.FunctionRuntime.JS_2_0,
    comment:
      'Names the viewer address and host; clears oversized Supabase session cookies',
    code: cloudfront.FunctionCode.fromInline(VIEWER_REQUEST_SOURCE),
  });

/**
 * The challenge an MCP client follows to the server's authorization metadata
 * (RFC 9728), for the edge to add to the server's `/mcp` answers. A function
 * URL renames the application's own `WWW-Authenticate` header to
 * `x-amzn-remapped-www-authenticate`, and an edge function cannot put it back
 * on a 401, since CloudFront runs none for origin errors. A response headers
 * policy can: it adds this header when the origin's answer has none, which
 * behind a function URL is always. Without a custom domain the distribution
 * cannot name its own address here, so the challenge leaves out where the
 * metadata is, and clients look for it at the well-known path.
 */
export const mcpChallenge = (publicUrl: string | undefined): string =>
  publicUrl
    ? `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp"`
    : 'Bearer';
