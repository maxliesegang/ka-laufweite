import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Stop } from '../types';

const cacheMocks = vi.hoisted(() => ({
  marker: '',
  getPolygon: vi.fn(),
  setPolygon: vi.fn(),
}));
const fetchMocks = vi.hoisted(() => ({ fetchFootwayNetworkInBounds: vi.fn() }));
const shippedMocks = vi.hoisted(() => ({ getPolygon: vi.fn() }));

vi.mock('../walkshed-cache', () => ({
  getCachedWalkshedPolygon: cacheMocks.getPolygon,
  getWalkshedUnavailableRetryAfter: vi.fn().mockResolvedValue(null),
  getWalkshedCacheResetMarker: () => cacheMocks.marker,
  setCachedWalkshedPolygon: cacheMocks.setPolygon,
  setCachedWalkshedUnavailable: vi.fn(),
}));
vi.mock('./overpass', () => ({
  fetchFootwayNetworkInBounds: fetchMocks.fetchFootwayNetworkInBounds,
}));
vi.mock('./shipped-walksheds', () => ({
  loadShippedWalkshedPolygon: shippedMocks.getPolygon,
}));

import {
  buildWalkshedPolygon,
  clearWalkshedRuntimeCache,
  loadCachedWalkshedPolygon,
} from './service';

const stop: Stop = { id: 'custom-1', name: 'Test', lat: 49, lon: 8.001, type: 'bus' };

describe('walkshed service revisions', () => {
  beforeEach(() => {
    clearWalkshedRuntimeCache();
    cacheMocks.marker = '';
    cacheMocks.getPolygon.mockReset().mockResolvedValue(null);
    cacheMocks.setPolygon.mockReset();
    fetchMocks.fetchFootwayNetworkInBounds.mockReset();
    shippedMocks.getPolygon.mockReset().mockResolvedValue(null);
  });

  it('prefers a persisted polygon over the shipped default', async () => {
    const persistedPolygon = [[49, 8]] as const;
    cacheMocks.getPolygon.mockResolvedValue(persistedPolygon);

    expect(await loadCachedWalkshedPolygon(stop, 500)).toBe(persistedPolygon);
    expect(shippedMocks.getPolygon).not.toHaveBeenCalled();
  });

  it('uses a shipped polygon on a persistent cache miss', async () => {
    const shippedPolygon = [[49, 8]] as const;
    shippedMocks.getPolygon.mockResolvedValue(shippedPolygon);

    expect(await loadCachedWalkshedPolygon(stop, 500)).toBe(shippedPolygon);
  });

  it('restores a shipped default after the persistent and runtime caches are cleared', async () => {
    const persistedPolygon = [[49, 8]] as const;
    const shippedPolygon = [[49.001, 8.001]] as const;
    cacheMocks.getPolygon.mockResolvedValue(persistedPolygon);
    shippedMocks.getPolygon.mockResolvedValue(shippedPolygon);

    expect(await loadCachedWalkshedPolygon(stop, 500)).toBe(persistedPolygon);

    clearWalkshedRuntimeCache();
    cacheMocks.getPolygon.mockResolvedValue(null);

    expect(await buildWalkshedPolygon(stop, 500)).toEqual({
      status: 'polygon',
      polygon: shippedPolygon,
    });
    expect(fetchMocks.fetchFootwayNetworkInBounds).not.toHaveBeenCalled();
  });

  it('does not commit a calculation superseded by cache invalidation', async () => {
    let resolveFetch: ((value: unknown) => void) | undefined;
    fetchMocks.fetchFootwayNetworkInBounds.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const pending = buildWalkshedPolygon(stop, 500);
    await vi.waitFor(() => expect(fetchMocks.fetchFootwayNetworkInBounds).toHaveBeenCalledOnce());
    clearWalkshedRuntimeCache();
    resolveFetch?.({
      status: 'ok',
      networkData: {
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
