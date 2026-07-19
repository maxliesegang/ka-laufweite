import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Stop } from '../types';
import type { BoundingBox, LatLng, OverpassResponse } from './types';

const cacheMocks = vi.hoisted(() => ({
  marker: '',
  getPolygon: vi.fn(),
  setPolygon: vi.fn(),
  getUnavailable: vi.fn(),
  setUnavailable: vi.fn(),
}));
const fetchMocks = vi.hoisted(() => ({ fetchFootwayNetworkInBounds: vi.fn() }));
const shippedMocks = vi.hoisted(() => ({ getPolygon: vi.fn() }));

vi.mock('../walkshed-cache', () => ({
  getCachedWalkshedPolygon: cacheMocks.getPolygon,
  getWalkshedUnavailableRetryAfter: cacheMocks.getUnavailable,
  getWalkshedCacheResetMarker: () => cacheMocks.marker,
  setCachedWalkshedPolygon: cacheMocks.setPolygon,
  setCachedWalkshedUnavailable: cacheMocks.setUnavailable,
}));
vi.mock('./overpass', () => ({
  fetchFootwayNetworkInBounds: fetchMocks.fetchFootwayNetworkInBounds,
}));
vi.mock('./shipped-walksheds', () => ({ loadShippedWalkshedPolygon: shippedMocks.getPolygon }));

import { walkshedCacheKey } from './cache-key';
import { buildWalkshedPolygons, clearWalkshedRuntimeCache, type WalkshedResult } from './service';

/**
 * A dense footway lattice around (49, 8) so any stop placed inside it snaps to a
 * nearby edge and produces a polygon. Roughly 89 m spacing over ~450 m square.
 */
function gridResponse(): OverpassResponse {
  const rows = 6;
  const cols = 6;
  const lat0 = 48.998;
  const lon0 = 7.998;
  const step = 0.0008;
  const nodeId = (r: number, c: number) => r * 100 + c + 1;
  const elements: OverpassResponse['elements'] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      elements.push({ type: 'node', id: nodeId(r, c), lat: lat0 + r * step, lon: lon0 + c * step });
    }
  }
  let wayId = 100_000;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (c + 1 < cols) {
        elements.push({
          type: 'way',
          id: (wayId += 1),
          nodes: [nodeId(r, c), nodeId(r, c + 1)],
          tags: { highway: 'footway' },
        });
      }
      if (r + 1 < rows) {
        elements.push({
          type: 'way',
          id: (wayId += 1),
          nodes: [nodeId(r, c), nodeId(r + 1, c)],
          tags: { highway: 'footway' },
        });
      }
    }
  }
  return { elements };
}

function resolveNetworkFetch(networkData: OverpassResponse): void {
  fetchMocks.fetchFootwayNetworkInBounds.mockResolvedValue({ status: 'ok', networkData });
}

function stop(id: string, lat: number, lon: number): Stop {
  return { id, name: id, lat, lon, type: 'bus' };
}

function boundingArea(polygon: LatLng[]): number {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const [lat, lon] of polygon) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }
  return (maxLat - minLat) * (maxLon - minLon);
}

function polygonOf(result: WalkshedResult | undefined): LatLng[] {
  if (!result || result.status !== 'polygon')
    throw new Error(`expected polygon, got ${result?.status}`);
  return result.polygon;
}

describe('buildWalkshedPolygons', () => {
  beforeEach(() => {
    clearWalkshedRuntimeCache();
    cacheMocks.marker = '';
    cacheMocks.getPolygon.mockReset().mockResolvedValue(null);
    cacheMocks.setPolygon.mockReset().mockResolvedValue(undefined);
    cacheMocks.getUnavailable.mockReset().mockResolvedValue(null);
    cacheMocks.setUnavailable.mockReset().mockResolvedValue(undefined);
    fetchMocks.fetchFootwayNetworkInBounds.mockReset();
    shippedMocks.getPolygon.mockReset().mockResolvedValue(null);
  });

  it('fetches one shared network for several nearby stops and gives each a polygon', async () => {
    resolveNetworkFetch(gridResponse());
    const stops = [stop('a', 49, 8), stop('b', 49.0008, 8.0008), stop('c', 48.9992, 7.9992)];

    const results = await buildWalkshedPolygons(
      stops.map((s) => ({ stop: s, radiusMeters: 200 })),
      true,
    );

    expect(fetchMocks.fetchFootwayNetworkInBounds).toHaveBeenCalledOnce();
    for (const s of stops) expect(results.get(s.id)?.status).toBe('polygon');
  });

  it('routes each stop from its own coordinates and radius against the shared graph', async () => {
    resolveNetworkFetch(gridResponse());
    const near = stop('near', 49, 8);
    const far = stop('far', 49.0016, 8.0016);

    const results = await buildWalkshedPolygons(
      [
        { stop: near, radiusMeters: 200 },
        { stop: far, radiusMeters: 200 },
      ],
      true,
    );

    // Same radius, different coordinates → different polygons (own seeds).
    const nearPoly = polygonOf(results.get('near'));
    const farPoly = polygonOf(results.get('far'));
    const nearCentroidLat = nearPoly.reduce((sum, [lat]) => sum + lat, 0) / nearPoly.length;
    const farCentroidLat = farPoly.reduce((sum, [lat]) => sum + lat, 0) / farPoly.length;
    expect(farCentroidLat).toBeGreaterThan(nearCentroidLat);
  });

  it('serves different radii from one sufficiently large shared graph', async () => {
    resolveNetworkFetch(gridResponse());
    const small = stop('small', 49, 8);
    const large = stop('large', 49.0008, 8.0008);

    const results = await buildWalkshedPolygons(
      [
        { stop: small, radiusMeters: 150 },
        { stop: large, radiusMeters: 400 },
      ],
      true,
    );

    // A batch of mixed radii uses the largest radius's bucket for one request.
    expect(fetchMocks.fetchFootwayNetworkInBounds).toHaveBeenCalledOnce();
    expect(boundingArea(polygonOf(results.get('large')))).toBeGreaterThan(
      boundingArea(polygonOf(results.get('small'))),
    );
  });

  it('reuses a bucket graph for a later smaller-radius request in the same area', async () => {
    resolveNetworkFetch(gridResponse());
    const s = stop('a', 49, 8);

    await buildWalkshedPolygons([{ stop: s, radiusMeters: 300 }], true);
    // 250 and 300 share the 300 bucket and the same area, so no new fetch.
    await buildWalkshedPolygons([{ stop: s, radiusMeters: 250 }], true);

    expect(fetchMocks.fetchFootwayNetworkInBounds).toHaveBeenCalledOnce();
  });

  it('keeps cached stops out of the shared network request', async () => {
    resolveNetworkFetch(gridResponse());
    const cached = stop('cached', 49.05, 8.05); // far away — would widen bounds if included
    const uncached = stop('uncached', 49, 8);
    const cachedKey = walkshedCacheKey('cached', 200, 49.05, 8.05, true);
    cacheMocks.getPolygon.mockImplementation(async (key: string) =>
      key === cachedKey ? ([[49.05, 8.05]] as LatLng[]) : null,
    );

    const results = await buildWalkshedPolygons(
      [
        { stop: cached, radiusMeters: 200 },
        { stop: uncached, radiusMeters: 200 },
      ],
      true,
    );

    expect(results.get('cached')).toEqual({ status: 'polygon', polygon: [[49.05, 8.05]] });
    expect(fetchMocks.fetchFootwayNetworkInBounds).toHaveBeenCalledOnce();
    const bounds = fetchMocks.fetchFootwayNetworkInBounds.mock.calls[0][0] as BoundingBox;
    // The far cached stop never widened the shared query bounds.
    expect(cached.lat).toBeGreaterThan(bounds.north);
  });

  it('isolates a stop-specific no-data condition from its batch neighbours', async () => {
    resolveNetworkFetch(gridResponse());
    const onGrid = stop('on-grid', 49, 8);
    const offGrid = stop('off-grid', 49.01, 8); // > SNAP_DISTANCE from any footway

    const results = await buildWalkshedPolygons(
      [
        { stop: onGrid, radiusMeters: 200 },
        { stop: offGrid, radiusMeters: 200 },
      ],
      true,
    );

    expect(results.get('on-grid')?.status).toBe('polygon');
    const offResult = results.get('off-grid');
    expect(offResult).toMatchObject({ status: 'unavailable', reason: 'no-nearby-edge' });
  });

  it('marks every batch stop transiently unavailable when the shared request fails', async () => {
    fetchMocks.fetchFootwayNetworkInBounds.mockResolvedValue({ status: 'all-endpoints-failed' });
    const stops = [stop('a', 49, 8), stop('b', 49.0008, 8.0008)];

    const results = await buildWalkshedPolygons(
      stops.map((s) => ({ stop: s, radiusMeters: 200 })),
      true,
    );

    for (const s of stops) {
      expect(results.get(s.id)).toMatchObject({ status: 'unavailable', reason: 'network' });
    }
    // Transient window (2 min), not the 24 h no-data window.
    expect(cacheMocks.setUnavailable).toHaveBeenCalledWith(expect.any(String), 2 * 60 * 1_000);
  });

  it('does not persist results for an already-aborted batch', async () => {
    resolveNetworkFetch(gridResponse());
    const controller = new AbortController();
    controller.abort();

    const results = await buildWalkshedPolygons(
      [{ stop: stop('a', 49, 8), radiusMeters: 200 }],
      true,
      controller.signal,
    );

    expect(results.get('a')).toEqual({ status: 'superseded' });
    expect(fetchMocks.fetchFootwayNetworkInBounds).not.toHaveBeenCalled();
    expect(cacheMocks.setPolygon).not.toHaveBeenCalled();
  });

  it('discards a persistent cache read invalidated while it is in flight', async () => {
    let resolveCachedPolygon: ((polygon: LatLng[]) => void) | undefined;
    cacheMocks.getPolygon.mockReturnValue(
      new Promise((resolve) => {
        resolveCachedPolygon = resolve;
      }),
    );
    const pending = buildWalkshedPolygons(
      [{ stop: stop('stale', 49, 8), radiusMeters: 200 }],
      true,
    );

    await vi.waitFor(() => expect(cacheMocks.getPolygon).toHaveBeenCalledOnce());
    clearWalkshedRuntimeCache();
    resolveCachedPolygon?.([[49, 8]]);

    expect((await pending).get('stale')).toEqual({ status: 'superseded' });
    expect(fetchMocks.fetchFootwayNetworkInBounds).not.toHaveBeenCalled();
  });

  it('keeps a shared request alive while another consumer still needs it', async () => {
    let resolveFetch:
      ((value: { status: 'ok'; networkData: OverpassResponse }) => void) | undefined;
    let fetchSignal: AbortSignal | undefined;
    fetchMocks.fetchFootwayNetworkInBounds.mockImplementation(
      (_bounds: BoundingBox, signal?: AbortSignal) => {
        fetchSignal = signal;
        return new Promise((resolve) => {
          resolveFetch = resolve;
        });
      },
    );

    const firstController = new AbortController();
    const first = buildWalkshedPolygons(
      [{ stop: stop('first', 49, 8), radiusMeters: 200 }],
      true,
      firstController.signal,
    );
    const second = buildWalkshedPolygons(
      [{ stop: stop('second', 49, 8), radiusMeters: 200 }],
      true,
    );

    await vi.waitFor(() => expect(fetchMocks.fetchFootwayNetworkInBounds).toHaveBeenCalledOnce());
    await Promise.resolve();
    firstController.abort();

    expect(fetchSignal?.aborted).toBe(false);
    resolveFetch?.({ status: 'ok', networkData: gridResponse() });

    expect((await first).get('first')).toEqual({ status: 'superseded' });
    expect((await second).get('second')?.status).toBe('polygon');
  });

  it('starts a fresh request after the only consumer aborts', async () => {
    fetchMocks.fetchFootwayNetworkInBounds
      .mockImplementationOnce((_bounds: BoundingBox, signal?: AbortSignal) => {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      })
      .mockResolvedValueOnce({ status: 'ok', networkData: gridResponse() });

    const controller = new AbortController();
    const aborted = buildWalkshedPolygons(
      [{ stop: stop('aborted', 49, 8), radiusMeters: 200 }],
      true,
      controller.signal,
    );
    await vi.waitFor(() => expect(fetchMocks.fetchFootwayNetworkInBounds).toHaveBeenCalledOnce());
    controller.abort();

    const replacement = buildWalkshedPolygons(
      [{ stop: stop('replacement', 49, 8), radiusMeters: 200 }],
      true,
    );

    expect((await aborted).get('aborted')).toEqual({ status: 'superseded' });
    expect((await replacement).get('replacement')?.status).toBe('polygon');
    expect(fetchMocks.fetchFootwayNetworkInBounds).toHaveBeenCalledTimes(2);
  });

  it('does not persist a batch superseded by a runtime-cache reset mid-flight', async () => {
    let resolveFetch:
      ((value: { status: 'ok'; networkData: OverpassResponse }) => void) | undefined;
    fetchMocks.fetchFootwayNetworkInBounds.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const pending = buildWalkshedPolygons(
      [
        { stop: stop('a', 49, 8), radiusMeters: 200 },
        { stop: stop('b', 49.0008, 8.0008), radiusMeters: 200 },
      ],
      true,
    );
    await vi.waitFor(() => expect(fetchMocks.fetchFootwayNetworkInBounds).toHaveBeenCalledOnce());
    clearWalkshedRuntimeCache();
    resolveFetch?.({ status: 'ok', networkData: gridResponse() });

    const results = await pending;
    expect(results.get('a')).toEqual({ status: 'superseded' });
    expect(results.get('b')).toEqual({ status: 'superseded' });
    expect(cacheMocks.setPolygon).not.toHaveBeenCalled();
  });

  it('persists each stop under its own per-stop, per-coordinate cache key', async () => {
    resolveNetworkFetch(gridResponse());
    const a = stop('a', 49, 8);
    const b = stop('b', 49.0008, 8.0008);

    await buildWalkshedPolygons(
      [
        { stop: a, radiusMeters: 200 },
        { stop: b, radiusMeters: 300 },
      ],
      true,
    );

    const keys = cacheMocks.setPolygon.mock.calls.map((call) => call[0] as string);
    expect(keys).toContain(walkshedCacheKey('a', 200, 49, 8, true));
    expect(keys).toContain(walkshedCacheKey('b', 300, 49.0008, 8.0008, true));
  });
});
