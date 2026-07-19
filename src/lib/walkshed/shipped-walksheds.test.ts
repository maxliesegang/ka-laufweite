import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Stop } from '../types';
import {
  WALKSHED_DATA_PRECISION,
  WALKSHED_DATA_VERSION,
  encodeWalkshedPolygon,
  walkshedDatasetPolygonKey,
} from './walkshed-codec';
import type { LatLng } from './types';

const stop: Stop = { id: 'osm-1', name: 'Test', lat: 49, lon: 8, type: 'tram' };
const polygon: LatLng[] = [
  [49, 8],
  [49.001, 8],
  [49, 8.001],
];

function stubDatasetFetch(polygonKey: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        version: WALKSHED_DATA_VERSION,
        generatedAt: '2026-07-19T12:00:00.000Z',
        precision: WALKSHED_DATA_PRECISION,
        allowReasonableStreetCrossings: true,
        radiusByType: { train: 400, tram: 300, bus: 200 },
        polygons: { [polygonKey]: encodeWalkshedPolygon(polygon) },
      }),
    }),
  );
}

describe('shipped walksheds', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('loads polygons only for the matching stop snapshot', async () => {
    stubDatasetFetch(walkshedDatasetPolygonKey(stop));
    const { getShippedWalkshedPolygon } = await import('./shipped-walksheds');

    expect(await getShippedWalkshedPolygon(stop, 300, true)).not.toBeNull();
    expect(
      await getShippedWalkshedPolygon({ ...stop, lat: stop.lat + 0.001 }, 300, true),
    ).toBeNull();
  });

  it('fetches only the dataset for the requested stop type', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        version: WALKSHED_DATA_VERSION,
        generatedAt: '2026-07-19T12:00:00.000Z',
        precision: WALKSHED_DATA_PRECISION,
        allowReasonableStreetCrossings: true,
        radiusByType: { train: 400, tram: 300, bus: 200 },
        polygons: { [walkshedDatasetPolygonKey(stop)]: encodeWalkshedPolygon(polygon) },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { preloadShippedWalksheds, getShippedWalkshedPolygon } =
      await import('./shipped-walksheds');

    await preloadShippedWalksheds(['tram']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('walksheds-tram.json');

    // A bus lookup fetches only the bus dataset; tram is already cached.
    await getShippedWalkshedPolygon({ ...stop, type: 'bus' }, 200, true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('walksheds-bus.json');
  });
});
