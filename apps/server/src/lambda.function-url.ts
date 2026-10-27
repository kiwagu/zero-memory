/**
 * The event a Lambda function URL delivers (payload format 2.0) and the result
 * it expects back. Only the fields this server reads are typed.
 */
export interface FunctionUrlEvent {
  version: '2.0';
  rawPath: string;
  rawQueryString?: string;
  cookies?: string[];
  headers?: Record<string, string | undefined>;
  requestContext: {
    domainName: string;
    http: { method: string; sourceIp: string };
  };
  body?: string;
  isBase64Encoded?: boolean;
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
  isBase64Encoded: boolean;
}

const TEXTUAL_CONTENT_TYPE =
  /^(text\/|application\/(json|[\w.+-]*\+json|javascript|x-www-form-urlencoded|xml))/i;

/** The event as the Request the HTTP handler takes. */
export const requestFromFunctionUrlEvent = (
  event: FunctionUrlEvent
): Request => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) {
      headers.set(name, value);
    }
  }
  if (event.cookies?.length) {
    headers.set('cookie', event.cookies.join('; '));
  }
  const host = headers.get('host') ?? event.requestContext.domainName;
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const method = event.requestContext.http.method.toUpperCase();
  const hasBody =
    event.body !== undefined && method !== 'GET' && method !== 'HEAD';
  return new Request(`https://${host}${event.rawPath}${query}`, {
    method,
    headers,
    body: hasBody
      ? event.isBase64Encoded
        ? Buffer.from(event.body as string, 'base64')
        : event.body
      : undefined,
  });
};

/**
 * The whole response, read to its end, as the result a function URL returns.
 * Reading to the end is what makes an SSE answer to a POST fit here: the
 * stream closes once the last JSON-RPC response is written, so the body is a
 * finite, valid event stream.
 */
export const functionUrlResultFromResponse = async (
  response: Response
): Promise<FunctionUrlResult> => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') {
      headers[name] = value;
    }
  });
  const cookies = response.headers.getSetCookie();
  const contentType = response.headers.get('content-type') ?? '';
  const bytes = new Uint8Array(await response.arrayBuffer());
  const textual =
    bytes.byteLength === 0 || TEXTUAL_CONTENT_TYPE.test(contentType);
  return {
    statusCode: response.status,
    headers,
    ...(cookies.length > 0 ? { cookies } : {}),
    body: textual
      ? new TextDecoder().decode(bytes)
      : Buffer.from(bytes).toString('base64'),
    isBase64Encoded: !textual,
  };
};
