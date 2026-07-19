import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Stop } from '../../lib/types';
import type { LatLng } from '../../lib/walkshed/types';
import type { WalkshedRequest, WalkshedResult } from '../../lib/walkshed/service';

const serviceMocks = vi.hoisted(() => ({
  buildBatch: vi.fn(),
  peek: vi.fn(),
}));

vi.mock('../../lib/walkshed/service', () => ({
  buildWalkshedPolygons: serviceMocks.buildBatch,
  loadCachedWalkshedPolygon: serviceMocks.peek,
}));

import { WalkshedOverlayManager } from './walkshed-overlay-manager';

class FakeGeoJSONSource {
  data: unknown = null;
  setDataCalls = 0;
  setData(data: unknown): void {
    this.data = data;
    this.setDataCalls += 1;
  }
}

class FakeMap {
  readonly sources = new Map<string, FakeGeoJSONSource>();
  center = { lat: 49, lng: 8 };
  bounds = { north: 49.1, south: 48.9, east: 8.1, west: 7.9 };

  addSource(id: string): void {
    this.sources.set(id, new FakeGeoJSONSource());
  }
  addLayer(): void {}
  getSource(id: string): FakeGeoJSONSource | undefined {
    return this.sources.get(id);
  }
  getBounds() {
    return {
      getNorth: () => this.bounds.north,
      getSouth: () => this.bounds.south,
      getEast: () => this.bounds.east,
      getWest: () => this.bounds.west,
    };
  }
  getCenter() {
    return this.center;
  }
  getCanvas() {
    return { style: {} as CSSStyleDeclaration };
  }
  on(): void {}
}

function trianglePolygon(stop: Stop): LatLng[] {
  return [
    [stop.lat, stop.lon],
    [stop.lat + 0.0005, stop.lon],
    [stop.lat, stop.lon + 0.0005],
  ];
}

function polygonResults(requests: WalkshedRequest[]): Map<string, WalkshedResult> {
  const results = new Map<string, WalkshedResult>();
  for (const { stop } of requests) {
    results.set(stop.id, { status: 'polygon', polygon: trianglePolygon(stop) });
  }
  return results;
}

function stop(id: string, lat: number, lon: number): Stop {
  return { id, name: id, lat, lon, type: 'bus' };
}

function createManager(map: FakeMap): WalkshedOverlayManager {
  return new WalkshedOverlayManager({
    map: map as unknown as MapLibreMap,
    getRadiusMetersForType: () => 200,
    isEnabled: () => true,
    getAllowReasonableStreetCrossings: () => true,
  });
}

describe('WalkshedOverlayManager batching', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id: number) => globalThis.clearTimeout(id),
    });
    vi.useFakeTimers();
    serviceMocks.peek.mockReset().mockResolvedValue(null);
    serviceMocks.buildBatch
      .mockReset()
      .mockImplementation(async (requests: WalkshedRequest[]) => polygonResults(requests));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('groups nearby queued stops into one shared request and one polygon setData', async () => {
    const map = new FakeMap();
    const manager = createManager(map);
    manager.setStops([stop('a', 49, 8), stop('b', 49.0005, 8.0005), stop('c', 48.9995, 7.9995)]);
    const polygonSource = map.getSource('walkshed-polygons');
    // Baseline after the initial (empty) clear render; count only the batch update.
    const setDataBefore = polygonSource?.setDataCalls ?? 0;

    await vi.advanceTimersByTimeAsync(150);

    expect(serviceMocks.buildBatch).toHaveBeenCalledOnce();
    const requests = serviceMocks.buildBatch.mock.calls[0][0] as WalkshedRequest[];
    expect(requests.map((request) => request.stop.id).sort()).toEqual(['a', 'b', 'c']);

    // Exactly one setData for the whole batch's rendered polygons.
    expect((polygonSource?.setDataCalls ?? 0) - setDataBefore).toBe(1);
  });

  it('splits stops that are too far apart into separate batches', async () => {
    const map = new FakeMap();
    const manager = createManager(map);
    manager.setStops([
      stop('near-1', 49, 8),
      stop('near-2', 49.0005, 8.0005),
      stop('near-3', 48.9995, 7.9995),
      stop('far', 49.02, 8), // ~2.2 km north of the batch primary
    ]);

    await vi.advanceTimersByTimeAsync(150);

    expect(serviceMocks.buildBatch).toHaveBeenCalledTimes(2);
    const batches = serviceMocks.buildBatch.mock.calls.map((call) =>
      (call[0] as WalkshedRequest[]).map((request) => request.stop.id).sort(),
    );
    expect(batches).toContainEqual(['near-1', 'near-2', 'near-3']);
    expect(batches).toContainEqual(['far']);
  });

  it('limits query-area growth even when every stop is near the primary', async () => {
    const map = new FakeMap();
    const manager = createManager(map);
    manager.setStops([
      stop('center', 49, 8),
      stop('north-east', 49.01, 8.014),
      stop('south-west', 48.99, 7.986),
    ]);

    await vi.advanceTimersByTimeAsync(150);

    expect(serviceMocks.buildBatch).toHaveBeenCalledTimes(2);
    const batchSizes = serviceMocks.buildBatch.mock.calls
      .map((call) => (call[0] as WalkshedRequest[]).length)
      .sort();
    expect(batchSizes).toEqual([1, 2]);
  });

  it('puts up to 48 nearby stops into one shared network batch', async () => {
    const map = new FakeMap();
    const manager = createManager(map);
    manager.setStops(
      Array.from({ length: 49 }, (_, index) => {
        const row = Math.floor(index / 7) - 3;
        const column = (index % 7) - 3;
        return stop(`stop-${index}`, 49 + row * 0.0015, 8 + column * 0.0015);
      }),
    );

    await vi.advanceTimersByTimeAsync(150);

    const batchSizes = serviceMocks.buildBatch.mock.calls
      .map((call) => (call[0] as WalkshedRequest[]).length)
      .sort((a, b) => a - b);
    expect(batchSizes).toEqual([1, 48]);
  });

  it('prioritizes a clicked stop and pre-empts in-flight non-priority batches', async () => {
    const map = new FakeMap();
    const manager = createManager(map);
    const signals: (AbortSignal | undefined)[] = [];
    // First batch never resolves so it stays in flight until pre-empted.
    serviceMocks.buildBatch.mockImplementation(
      async (requests: WalkshedRequest[], _crossings: boolean, signal?: AbortSignal) => {
        signals.push(signal);
        if (signals.length === 1) return new Promise<Map<string, WalkshedResult>>(() => {});
        return polygonResults(requests);
      },
    );

    manager.setStops([stop('bg-1', 49, 8), stop('bg-2', 49.0005, 8.0005)]);
    await vi.advanceTimersByTimeAsync(150);
    expect(serviceMocks.buildBatch).toHaveBeenCalledOnce();

    const clicked = stop('clicked', 49.05, 8.05);
    manager.prioritizeStop(clicked);
    await vi.advanceTimersByTimeAsync(0);

    // The clicked stop got its own request without waiting for the stuck batch.
    const laterBatch = serviceMocks.buildBatch.mock.calls
      .slice(1)
      .flatMap((call) => (call[0] as WalkshedRequest[]).map((request) => request.stop.id));
    expect(laterBatch).toContain('clicked');
    // The pre-empted background batch was aborted.
    expect(signals[0]?.aborted).toBe(true);
  });

  it('does not render a member removed from a still-active batch', async () => {
    const map = new FakeMap();
    const manager = createManager(map);
    let resolveBatch: ((results: Map<string, WalkshedResult>) => void) | undefined;
    let batchRequests: WalkshedRequest[] = [];
    serviceMocks.buildBatch.mockImplementation(
      (requests: WalkshedRequest[]) =>
        new Promise((resolve) => {
          batchRequests = requests;
          resolveBatch = resolve;
        }),
    );

    manager.setStops([stop('keep', 49, 8), stop('drop', 49.0005, 8.0005)]);
    await vi.advanceTimersByTimeAsync(150);
    expect(batchRequests.map((request) => request.stop.id).sort()).toEqual(['drop', 'keep']);

    const internals = manager as unknown as { abortStopLoad: (stopId: string) => void };
    internals.abortStopLoad('drop');
    resolveBatch?.(polygonResults(batchRequests));
    await vi.advanceTimersByTimeAsync(0);

    const data = map.getSource('walkshed-polygons')?.data as
      { features: Array<{ properties: { stopId: string } }> } | undefined;
    expect(data?.features.map((feature) => feature.properties.stopId)).toEqual(['keep']);
  });
});
