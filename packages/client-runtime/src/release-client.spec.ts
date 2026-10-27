import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { fetchDeployedVersion } from './release-client.js';

const servers: Server[] = [];
const serve = async (handler: RequestListener): Promise<string> => {
  const created = createServer(handler);
  servers.push(created);
  await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(created.address() as AddressInfo).port}`;
};
afterEach(async () => {
  const running = servers.splice(0, servers.length);
  await Promise.all(
    running.map((one) => {
      one.closeAllConnections();
      return new Promise((resolve) => one.close(resolve));
    })
  );
});

describe('fetchDeployedVersion', () => {
  it('reads the version a url answers', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: 'v1.0.0+abc1234' }));
    });
    expect(
      await fetchDeployedVersion(`${base}/healthz`, 'version', 2000)
    ).toEqual({
      version: '1.0.0',
      build: 'abc1234',
    });
  });

  it('answers null for an error status, a body that is not JSON, and a url it will not read', async () => {
    let asked = 0;
    const base = await serve((req, res) => {
      asked += 1;
      if (req.url === '/down') {
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    });
    expect(
      await fetchDeployedVersion(`${base}/down`, 'version', 2000)
    ).toBeNull();
    expect(
      await fetchDeployedVersion(`${base}/text`, 'version', 2000)
    ).toBeNull();
    expect(asked).toBe(2);
    expect(
      await fetchDeployedVersion(
        'http://api.example.com/healthz',
        'version',
        2000
      )
    ).toBeNull();
    expect(
      await fetchDeployedVersion(
        'https://u:p@api.example.com/healthz',
        'version',
        2000
      )
    ).toBeNull();
    const port = new URL(base).port;
    expect(
      await fetchDeployedVersion(
        `http://u:p@127.0.0.1:${port}/healthz`,
        'version',
        2000
      )
    ).toBeNull();
    // Refused before any request was made — the count against the local
    // server did not move for any of the three urls, including the one
    // that could actually have reached it.
    expect(asked).toBe(2);
  });

  it('does not follow a redirect, even to an address the url rule would allow directly', async () => {
    let targetAsked = 0;
    const target = await serve((_req, res) => {
      targetAsked += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '9.9.9' }));
    });
    const base = await serve((_req, res) => {
      res.writeHead(302, { location: `${target}/internal` });
      res.end();
    });
    expect(
      await fetchDeployedVersion(`${base}/healthz`, 'version', 2000)
    ).toBeNull();
    expect(targetAsked).toBe(0);
  });

  it('gives up at its deadline when the url never answers', async () => {
    const base = await serve(() => {
      // Up, and silent.
    });
    const started = Date.now();
    expect(
      await fetchDeployedVersion(`${base}/healthz`, 'version', 1500)
    ).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500 + 3000);
  }, 15_000);
});
