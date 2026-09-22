import { describe, expect, it, vi } from 'vitest';

import { panelResponse } from './panel-response';

describe('panelResponse', () => {
  it('answers a found view with its data', async () => {
    const response = await panelResponse('memory', async () => ({
      title: 'a memory',
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: 'memory',
      title: 'a memory',
      view: { title: 'a memory' },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('answers a missing or unreadable view with 404', async () => {
    const response = await panelResponse('card', async () => null);
    expect(response.status).toBe(404);
  });

  it('answers a failed read with 500, never with 404', async () => {
    const response = await panelResponse('entity', async () => {
      throw new Error('entity: connection reset');
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal' });
  });

  it('keeps the cause of a failed read in the server log', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('entity: connection reset');
    await panelResponse('entity', async () => {
      throw failure;
    });
    expect(log).toHaveBeenCalledWith('panel entity:', failure);
    log.mockRestore();
  });
});
