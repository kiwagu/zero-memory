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
 * The viewer-request function every distribution of this app runs. It names,
 * in headers of its own, what only CloudFront knows for sure, overwriting any
 * value a client sent under the same names:
 *
 * - `x-viewer-address`: the address the request came from. CloudFront
 *   forwards a client's own X-Forwarded-For with the real address appended,
 *   so that header's first hop is whatever the client wrote;
 * - `x-forwarded-host`: the host name the browser used. The origin sees the
 *   function URL's own name as Host, and Next.js compares the browser's
 *   Origin with the forwarded host before it runs a Server Action.
 */
export const viewerRequestFunction = (
  scope: Construct,
  id: string
): cloudfront.Function =>
  new cloudfront.Function(scope, id, {
    runtime: cloudfront.FunctionRuntime.JS_2_0,
    comment: 'Names the viewer address and host for the origin',
    code: cloudfront.FunctionCode.fromInline(
      [
        'function handler(event) {',
        '  var headers = event.request.headers;',
        "  headers['x-viewer-address'] = { value: event.viewer.ip };",
        "  headers['x-forwarded-host'] = { value: headers.host.value };",
        '  return event.request;',
        '}',
      ].join('\n')
    ),
  });
