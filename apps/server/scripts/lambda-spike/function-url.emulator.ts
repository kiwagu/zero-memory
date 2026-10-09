/**
 * A local stand-in for a Lambda function URL: it turns each HTTP request into
 * a payload-2.0 event, invokes one of several Runtime Interface Emulator
 * instances, and turns the result back into an HTTP response. Like Lambda,
 * an instance serves one request at a time: a request waits for an idle one,
 * and idle instances are taken in rotation, so consecutive requests of one MCP
 * session land on different instances.
 *
 *   bun scripts/lambda-spike/function-url.emulator.ts <port> <rie-url>...
 *
 * Each <rie-url> is a container's invoke base, e.g. http://127.0.0.1:9101.
 * With ZM_ORIGIN_VERIFY set, every request carries it in `x-origin-verify`
 * and the caller's address in `x-viewer-address`, as the CloudFront
 * distribution in front of the real function does.
 */

interface InvokeResult {
  statusCode: number;
  headers?: Record<string, string>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
}

const [portArg, ...backends] = process.argv.slice(2);
if (!portArg || backends.length === 0) {
  console.error('usage: function-url.emulator.ts <port> <rie-url>...');
  process.exit(2);
}

const idle = [...backends];
const waiting: Array<(backend: string) => void> = [];
const acquire = (): Promise<string> => {
  const backend = idle.shift();
  return backend
    ? Promise.resolve(backend)
    : new Promise((resolve) => waiting.push(resolve));
};
const release = (backend: string): void => {
  const next = waiting.shift();
  if (next) {
    next(backend);
  } else {
    idle.push(backend);
  }
};
const served: Record<string, number> = {};

Bun.serve({
  port: Number(portArg),
  idleTimeout: 255,
  fetch: async (request, server) => {
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const sourceIp = server.requestIP(request)?.address ?? '127.0.0.1';
    const edgeValue = process.env.ZM_ORIGIN_VERIFY;
    if (edgeValue) {
      headers['x-origin-verify'] = edgeValue;
      headers['x-viewer-address'] = sourceIp;
    }
    const body = await request.arrayBuffer();
    const event = {
      version: '2.0',
      rawPath: url.pathname,
      rawQueryString: url.search.slice(1),
      headers,
      requestContext: {
        domainName: url.host,
        http: {
          method: request.method,
          sourceIp,
        },
      },
      body: body.byteLength ? Buffer.from(body).toString('base64') : undefined,
      isBase64Encoded: body.byteLength > 0,
    };
    const queued = performance.now();
    const backend = await acquire();
    const started = performance.now();
    let result: InvokeResult;
    try {
      const invoked = await fetch(
        `${backend}/2015-03-31/functions/function/invocations`,
        { method: 'POST', body: JSON.stringify(event) }
      );
      result = (await invoked.json()) as InvokeResult;
    } finally {
      release(backend);
    }
    served[backend] = (served[backend] ?? 0) + 1;
    console.log(
      JSON.stringify({
        method: request.method,
        path: url.pathname,
        backend,
        status: result.statusCode,
        wait_ms: Math.round(started - queued),
        ms: Math.round(performance.now() - started),
      })
    );
    const responseHeaders = new Headers(result.headers ?? {});
    for (const cookie of result.cookies ?? []) {
      responseHeaders.append('set-cookie', cookie);
    }
    const payload = result.body
      ? result.isBase64Encoded
        ? Buffer.from(result.body, 'base64')
        : result.body
      : null;
    return new Response(payload, {
      status: result.statusCode,
      headers: responseHeaders,
    });
  },
});

process.on('SIGINT', () => {
  console.log(JSON.stringify({ served }));
  process.exit(0);
});
console.log(`function URL emulator on :${portArg} → ${backends.join(', ')}`);
