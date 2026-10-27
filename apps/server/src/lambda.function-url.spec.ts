import { describe, expect, it } from 'vitest';

import {
  functionUrlResultFromResponse,
  requestFromFunctionUrlEvent,
  type FunctionUrlEvent,
} from './lambda.function-url.js';

const event = (
  overrides: Partial<FunctionUrlEvent> = {}
): FunctionUrlEvent => ({
  version: '2.0',
  rawPath: '/mcp',
  rawQueryString: 'a=1&b=two',
  headers: {
    host: 'abc.lambda-url.eu-central-1.on.aws',
    'content-type': 'application/json',
    'mcp-session-id': 'mcs_x',
  },
  requestContext: {
    domainName: 'abc.lambda-url.eu-central-1.on.aws',
    http: { method: 'POST', sourceIp: '203.0.113.7' },
  },
  ...overrides,
});

describe('requestFromFunctionUrlEvent', () => {
  it('rebuilds the request a listening server would have read, base64 body included', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const request = requestFromFunctionUrlEvent(
      event({
        cookies: ['sb=1', 'theme=dark'],
        body: Buffer.from(body).toString('base64'),
        isBase64Encoded: true,
      })
    );

    expect(request.method).toBe('POST');
    expect(request.url).toBe(
      'https://abc.lambda-url.eu-central-1.on.aws/mcp?a=1&b=two'
    );
    expect(request.headers.get('mcp-session-id')).toBe('mcs_x');
    expect(request.headers.get('cookie')).toBe('sb=1; theme=dark');
    expect(await request.json()).toEqual(JSON.parse(body));
  });

  it('passes a plain-text body through as is', async () => {
    const request = requestFromFunctionUrlEvent(
      event({ body: 'grant_type=refresh_token', isBase64Encoded: false })
    );

    expect(await request.text()).toBe('grant_type=refresh_token');
  });
});

describe('functionUrlResultFromResponse', () => {
  it('moves every Set-Cookie into cookies and keeps the other headers', async () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', 'a=1; Path=/');
    headers.append('set-cookie', 'b=2; Path=/');

    const result = await functionUrlResultFromResponse(
      new Response('{"ok":true}', { status: 201, headers })
    );

    expect(result).toEqual({
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      cookies: ['a=1; Path=/', 'b=2; Path=/'],
      body: '{"ok":true}',
      isBase64Encoded: false,
    });
  });

  it('base64-encodes a binary body so its bytes survive', async () => {
    const bytes = new Uint8Array([0xff, 0x00, 0x7f, 0x80]);

    const result = await functionUrlResultFromResponse(
      new Response(bytes, {
        headers: { 'content-type': 'application/octet-stream' },
      })
    );

    expect(result.isBase64Encoded).toBe(true);
    expect([...Buffer.from(result.body, 'base64')]).toEqual([...bytes]);
  });

  it('reads an event stream to its end, across every chunk', async () => {
    const chunks = ['event: message\ndata: {"id":1}\n\n', 'data: {"id":2}\n\n'];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    const result = await functionUrlResultFromResponse(
      new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    );

    expect(result.isBase64Encoded).toBe(false);
    expect(result.body).toBe(chunks.join(''));
  });
});
