import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Stop } from '../types';

const cacheMocks = vi.hoisted(() => ({
  marker: '',
  setPolygon: vi.fn(),
}));
const fetchMocks = vi.hoisted(() => ({ fetchFootways: vi.fn() }));

vi.mock('../walkshed-cache', () => ({
  getCachedWalkshedPolygon: vi.fn().mockResolvedValue(null),
  getWalkshedUnavailableRetryAfter: vi.fn().mockResolvedValue(null),
  getWalkshedCacheResetMarker: () => cacheMocks.marker,
  setCachedWalkshedPolygon: cacheMocks.setPolygon,
  setCachedWalkshedUnavailable: vi.fn(),
}));
vi.mock('./overpass', () => ({ fetchFootways: fetchMocks.fetchFootways }));

import { buildWalkshedPolygon, clearWalkshedRuntimeCache } from './service';

const stop: Stop = { id: 'custom-1', name: 'Test', lat: 49, lon: 8.001, type: 'bus' };

describe('walkshed service revisions', () => {
  beforeEach(() => {
    clearWalkshedRuntimeCache();
    cacheMocks.marker = '';
    cacheMocks.setPolygon.mockReset();
    fetchMocks.fetchFootways.mockReset();
  });

  it('does not commit a calculation superseded by cache invalidation', async () => {
    let resolveFetch: ((value: unknown) => void) | undefined;
    fetchMocks.fetchFootways.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const pending = buildWalkshedPolygon(stop, 500);
    await vi.waitFor(() => expect(fetchMocks.fetchFootways).toHaveBeenCalledOnce());
    clearWalkshedRuntimeCache();
    resolveFetch?.({
      status: 'ok',
      response: {
        elements: [
          { type: 'node', id: 1, lat: 49, lon: 8 },
          { type: 'node', id: 2, lat: 49, lon: 8.002 },
          { type: 'node', id: 3, lat: 49.002, lon: 8.001 },
          { type: 'way', id: 10, nodes: [1, 2, 3, 1] },
        ],
      },
    });

    expect(await pending).toEqual({ status: 'superseded' });
    expect(cacheMocks.setPolygon).not.toHaveBeenCalled();
  });
});
