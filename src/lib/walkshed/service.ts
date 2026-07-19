import {
  getCachedWalkshedPolygon,
  getWalkshedCacheResetMarker,
  getWalkshedUnavailableRetryAfter,
  setCachedWalkshedPolygon,
  setCachedWalkshedUnavailable,
} from '../walkshed-cache';
import type { Stop } from '../types';
import {
  calculateWalkshedPolygons,
  type WalkshedCalculationRequest,
  type WalkshedCalculationResult,
} from './polygon-calculation';
import {
  calculateWalkshedPolygonsInWorker,
  isWalkshedCalculationWorkerSupported,
  resetWalkshedCalculationWorker,
} from './polygon-calculation-worker-client';
import {
  MAX_CACHED_OVERPASS_ELEMENTS,
  MAX_CACHED_WALK_GRAPH_NODES,
  MAX_WALKSHED_AREA_CACHE_ENTRIES,
} from './constants';
import { walkshedCacheKey, walkshedCacheKeyPrefixForStop } from './cache-key';
import { buildWalkGraph } from './graph';
import { fetchFootwayNetworkInBounds } from './overpass';
import { createWalkshedQueryArea } from './query-area';
import { loadShippedWalkshedPolygon } from './shipped-walksheds';
import type { BoundingBox, LatLng, OverpassResponse, WalkGraph } from './types';
import { WeightedLruCache } from './weighted-lru-cache';

const TRANSIENT_UNAVAILABLE_RETRY_MS = 2 * 60 * 1_000;
const NO_DATA_UNAVAILABLE_RETRY_MS = 24 * 60 * 60 * 1_000;

interface FootwayNetworkLoadResult {
  networkData: OverpassResponse | null;
  transientFailure: boolean;
  aborted: boolean;
}

interface WalkGraphLoadResult {
  graph: WalkGraph | null;
  transientFailure: boolean;
  aborted: boolean;
}

/** In-flight shared network request, ref-counted so aborting one batch does not
 *  cancel a request another still-live batch is sharing. */
interface SharedFootwayNetworkRequest {
  promise: Promise<FootwayNetworkLoadResult>;
  controller: AbortController;
  consumerCount: number;
  settled: boolean;
}

// Raw Overpass responses and graphs are runtime-only and LRU-bounded.
const footwayNetworkCache = new WeightedLruCache<string, OverpassResponse>(
  MAX_WALKSHED_AREA_CACHE_ENTRIES,
  MAX_CACHED_OVERPASS_ELEMENTS,
);
const footwayNetworkRequests = new Map<string, SharedFootwayNetworkRequest>();
const walkGraphCache = new WeightedLruCache<string, WalkGraphLoadResult>(
  MAX_WALKSHED_AREA_CACHE_ENTRIES,
  MAX_CACHED_WALK_GRAPH_NODES,
);
const polygonCache = new Map<string, LatLng[]>();
let cacheEpoch = 0;
const stopRevisionById = new Map<string, number>();

interface WalkshedCacheSnapshot {
  epoch: number;
  resetMarker: string;
  stopRevision: number;
}

export interface WalkshedRequest {
  stop: Stop;
  radiusMeters: number;
}

export type WalkshedResult =
  | { status: 'polygon'; polygon: LatLng[] }
  | {
      status: 'unavailable';
      retryAfter: number;
      reason: 'cached' | 'network' | 'no-data' | 'no-nearby-edge' | 'invalid-polygon';
    }
  | { status: 'superseded' };

function captureCacheSnapshot(stopId: string): WalkshedCacheSnapshot {
  return {
    epoch: cacheEpoch,
    resetMarker: getWalkshedCacheResetMarker(),
    stopRevision: stopRevisionById.get(stopId) ?? 0,
  };
}

function isCacheSnapshotCurrent(stopId: string, snapshot: WalkshedCacheSnapshot): boolean {
  return (
    snapshot.epoch === cacheEpoch &&
    snapshot.resetMarker === getWalkshedCacheResetMarker() &&
    snapshot.stopRevision === (stopRevisionById.get(stopId) ?? 0)
  );
}

function getWalkshedPolygonCacheKey(
  stop: Stop,
  radiusMeters: number,
  allowReasonableStreetCrossings: boolean,
): string {
  return walkshedCacheKey(
    stop.id,
    radiusMeters,
    stop.lat,
    stop.lon,
    allowReasonableStreetCrossings,
  );
}

function walkGraphCacheKey(queryAreaKey: string, allowReasonableStreetCrossings: boolean): string {
  return `${queryAreaKey}:${allowReasonableStreetCrossings ? 'crossings' : 'mapped-only'}`;
}

/**
 * Fetch (or reuse) the shared walking network for an area. Concurrent callers
 * for the same area key share one request; each caller's abort signal only
 * decrements a ref count, so the underlying request is cancelled only once every
 * interested batch has aborted. Failed or aborted results are never left cached.
 */
async function loadFootwayNetwork(
  queryAreaKey: string,
  queryBounds: BoundingBox,
  signal?: AbortSignal,
): Promise<FootwayNetworkLoadResult> {
  if (signal?.aborted) {
    return { networkData: null, transientFailure: false, aborted: true };
  }

  const cached = footwayNetworkCache.get(queryAreaKey);
  if (cached) return { networkData: cached, transientFailure: false, aborted: false };

  let request = footwayNetworkRequests.get(queryAreaKey);
  if (request?.controller.signal.aborted) {
    footwayNetworkRequests.delete(queryAreaKey);
    request = undefined;
  }
  if (!request) {
    const controller = new AbortController();
    const requestEpoch = cacheEpoch;
    const sharedRequest: SharedFootwayNetworkRequest = {
      controller,
      consumerCount: 0,
      settled: false,
      promise: Promise.resolve({
        networkData: null,
        transientFailure: false,
        aborted: false,
      }),
    };
    sharedRequest.promise = fetchFootwayNetworkInBounds(queryBounds, controller.signal)
      .then((result): FootwayNetworkLoadResult =>
        result.status === 'ok'
          ? { networkData: result.networkData, transientFailure: false, aborted: false }
          : { networkData: null, transientFailure: true, aborted: false },
      )
      .catch((): FootwayNetworkLoadResult => ({
        networkData: null,
        transientFailure: !controller.signal.aborted,
        aborted: controller.signal.aborted,
      }))
      .then((result) => {
        sharedRequest.settled = true;
        if (footwayNetworkRequests.get(queryAreaKey) === sharedRequest) {
          footwayNetworkRequests.delete(queryAreaKey);
        }
        if (result.networkData && requestEpoch === cacheEpoch) {
          footwayNetworkCache.set(
            queryAreaKey,
            result.networkData,
            result.networkData.elements.length,
          );
        }
        return result;
      });
    request = sharedRequest;
    footwayNetworkRequests.set(queryAreaKey, sharedRequest);
  }

  const activeRequest = request;
  activeRequest.consumerCount += 1;

  return new Promise((resolve) => {
    let finished = false;
    const finish = (result: FootwayNetworkLoadResult) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', handleAbort);
      activeRequest.consumerCount -= 1;
      if (activeRequest.consumerCount === 0 && !activeRequest.settled) {
        activeRequest.controller.abort();
      }
      resolve(result);
    };
    const handleAbort = () => finish({ networkData: null, transientFailure: false, aborted: true });

    signal?.addEventListener('abort', handleAbort, { once: true });
    activeRequest.promise.then((result) => finish(result));
  });
}

/**
 * Build (or reuse) one WalkGraph for a shared area. Crossing behaviour changes
 * graph construction but not the Overpass query, so graph variants are cached
 * separately and both share the underlying network response.
 */
async function loadWalkGraph(
  queryAreaKey: string,
  queryBounds: BoundingBox,
  allowReasonableStreetCrossings: boolean,
  signal?: AbortSignal,
): Promise<WalkGraphLoadResult> {
  const walkGraphKey = walkGraphCacheKey(queryAreaKey, allowReasonableStreetCrossings);
  const cached = walkGraphCache.get(walkGraphKey);
  if (cached) {
    return signal?.aborted ? { graph: null, transientFailure: false, aborted: true } : cached;
  }

  const graphEpoch = cacheEpoch;
  const network = await loadFootwayNetwork(queryAreaKey, queryBounds, signal);
  if (network.aborted) return { graph: null, transientFailure: false, aborted: true };
  if (!network.networkData) {
    return { graph: null, transientFailure: network.transientFailure, aborted: false };
  }

  const result: WalkGraphLoadResult = {
    graph: buildWalkGraph(network.networkData, allowReasonableStreetCrossings),
    transientFailure: false,
    aborted: false,
  };
  if (graphEpoch === cacheEpoch) {
    walkGraphCache.set(walkGraphKey, result, result.graph?.nodes.length ?? 0);
  }
  return result;
}

export function clearWalkshedRuntimeCache(): void {
  cacheEpoch += 1;
  resetWalkshedCalculationWorker();
  for (const request of footwayNetworkRequests.values()) request.controller.abort();
  footwayNetworkCache.clear();
  footwayNetworkRequests.clear();
  walkGraphCache.clear();
  polygonCache.clear();
}

export function invalidateWalkshedRuntimeCacheForStop(stopId: string): void {
  stopRevisionById.set(stopId, (stopRevisionById.get(stopId) ?? 0) + 1);
  const prefix = walkshedCacheKeyPrefixForStop(stopId);
  for (const cacheKey of [...polygonCache.keys()]) {
    if (cacheKey.startsWith(prefix)) {
      polygonCache.delete(cacheKey);
    }
  }
}

/**
 * Load an already-computed polygon from memory, browser persistence, or the
 * shipped static dataset. Returns null on a miss so the caller can decide
 * whether to schedule the slower Overpass calculation separately.
 *
 * Keeping this free of Overpass calls lets the overlay render available stops
 * before queueing uncached neighbours that need a new calculation.
 */
export async function loadCachedWalkshedPolygon(
  stop: Stop,
  radiusMeters: number,
  allowReasonableStreetCrossings = true,
): Promise<LatLng[] | null> {
  const snapshot = captureCacheSnapshot(stop.id);
  const cacheKey = getWalkshedPolygonCacheKey(stop, radiusMeters, allowReasonableStreetCrossings);
  const inMemoryPolygon = polygonCache.get(cacheKey);
  if (inMemoryPolygon) {
    return inMemoryPolygon;
  }

  const persistedPolygon = await getCachedWalkshedPolygon(cacheKey);
  if (persistedPolygon) {
    if (!isCacheSnapshotCurrent(stop.id, snapshot)) return null;
    polygonCache.set(cacheKey, persistedPolygon);
    return persistedPolygon;
  }

  if (!isCacheSnapshotCurrent(stop.id, snapshot)) return null;

  // Shipped defaults avoid an Overpass request on a persistent-cache miss.
  const shippedPolygon = await loadShippedWalkshedPolygon(
    stop,
    radiusMeters,
    allowReasonableStreetCrossings,
  );
  if (shippedPolygon) {
    if (!isCacheSnapshotCurrent(stop.id, snapshot)) return null;
    polygonCache.set(cacheKey, shippedPolygon);
    return shippedPolygon;
  }

  return null;
}

interface PendingWalkshedRequest {
  request: WalkshedRequest;
  cacheKey: string;
  stopRevision: number;
}

function toCalculationRequest({ request }: PendingWalkshedRequest): WalkshedCalculationRequest {
  return {
    stopId: request.stop.id,
    lat: request.stop.lat,
    lon: request.stop.lon,
    radiusMeters: request.radiusMeters,
  };
}

function toWalkshedResult(result: WalkshedCalculationResult): WalkshedResult {
  if (result.status === 'polygon') return { status: 'polygon', polygon: result.polygon };
  return {
    status: 'unavailable',
    retryAfter: Date.now() + NO_DATA_UNAVAILABLE_RETRY_MS,
    reason: result.reason,
  };
}

/**
 * Build walkshed polygons for a batch of nearby stops. All uncached stops share
 * a single Overpass request and one WalkGraph, but every stop is then routed
 * and polygonised independently from its own coordinates and radius — the result
 * for a stop is equivalent to computing it from a sufficiently large per-stop
 * Overpass response.
 *
 * A per-stop failure (no nearby edge, invalid polygon) is isolated to that stop.
 * A shared-network failure is reported to every batch stop as a transient
 * `network` unavailability; a shared no-data area as a `no-data` unavailability.
 */
export async function buildWalkshedPolygons(
  requests: WalkshedRequest[],
  allowReasonableStreetCrossings = true,
  signal?: AbortSignal,
): Promise<Map<string, WalkshedResult>> {
  const results = new Map<string, WalkshedResult>();
  if (requests.length === 0) return results;

  const batchSnapshot = captureCacheSnapshot(requests[0].stop.id);
  const runtimeCacheEpoch = batchSnapshot.epoch;
  const persistentCacheMarker = batchSnapshot.resetMarker;
  const isRequestCurrent = (stopId: string, stopRevision: number): boolean =>
    runtimeCacheEpoch === cacheEpoch &&
    stopRevision === (stopRevisionById.get(stopId) ?? 0) &&
    persistentCacheMarker === getWalkshedCacheResetMarker();

  const pending = (
    await Promise.all(
      requests.map(async (request): Promise<PendingWalkshedRequest | null> => {
        const { stop, radiusMeters } = request;
        const stopRevision = stopRevisionById.get(stop.id) ?? 0;
        const cacheKey = getWalkshedPolygonCacheKey(
          stop,
          radiusMeters,
          allowReasonableStreetCrossings,
        );

        // Cached / shipped stops never enter the shared network batch.
        const cachedPolygon = await loadCachedWalkshedPolygon(
          stop,
          radiusMeters,
          allowReasonableStreetCrossings,
        );
        if (!isRequestCurrent(stop.id, stopRevision)) {
          results.set(stop.id, { status: 'superseded' });
          return null;
        }
        if (cachedPolygon) {
          results.set(stop.id, { status: 'polygon', polygon: cachedPolygon });
          return null;
        }
        const cachedRetryAfter = await getWalkshedUnavailableRetryAfter(cacheKey);
        if (!isRequestCurrent(stop.id, stopRevision)) {
          results.set(stop.id, { status: 'superseded' });
          return null;
        }
        if (cachedRetryAfter !== null) {
          results.set(stop.id, {
            status: 'unavailable',
            retryAfter: cachedRetryAfter,
            reason: 'cached',
          });
          return null;
        }
        return { request, cacheKey, stopRevision };
      }),
    )
  ).filter((entry): entry is PendingWalkshedRequest => entry !== null);

  if (pending.length === 0) return results;
  const supersedeAll = () => {
    for (const { request } of pending) results.set(request.stop.id, { status: 'superseded' });
    return results;
  };
  if (signal?.aborted) return supersedeAll();

  // Shared query bounds. Correctness requirement: the padded bounds must contain
  // every route reachable within any stop's radius. We take the box that
  // contains all pending stops, round it strictly outward, then pad it by the
  // radius bucket (>= the largest radius) plus the Overpass safety padding. Each
  // stop therefore keeps at least radius + QUERY_PADDING_METERS of margin to the
  // boundary in every direction, so no reachable edge is truncated at the query
  // edge — the batched result matches a large per-stop fetch.
  const queryArea = createWalkshedQueryArea(
    pending.map(({ request }) => ({
      lat: request.stop.lat,
      lon: request.stop.lon,
      radiusMeters: request.radiusMeters,
    })),
  );
  if (!queryArea) return supersedeAll();

  const calculationRequests = pending.map(toCalculationRequest);
  let polygonCalculationResults: WalkshedCalculationResult[] | null = null;
  let walkGraphLoadResult: WalkGraphLoadResult | null = null;

  if (isWalkshedCalculationWorkerSupported()) {
    const network = await loadFootwayNetwork(queryArea.cacheKey, queryArea.bounds, signal);
    if (network.aborted || signal?.aborted) return supersedeAll();
    if (!network.networkData) {
      walkGraphLoadResult = {
        graph: null,
        transientFailure: network.transientFailure,
        aborted: false,
      };
    } else {
      try {
        polygonCalculationResults = await calculateWalkshedPolygonsInWorker(
          walkGraphCacheKey(queryArea.cacheKey, allowReasonableStreetCrossings),
          network.networkData,
          allowReasonableStreetCrossings,
          calculationRequests,
          signal,
        );
      } catch (error) {
        if (signal?.aborted || runtimeCacheEpoch !== cacheEpoch) return supersedeAll();
        console.warn('Walkshed worker unavailable; calculating on the main thread.', error);
      }
    }
  }

  if (!polygonCalculationResults && !walkGraphLoadResult) {
    walkGraphLoadResult = await loadWalkGraph(
      queryArea.cacheKey,
      queryArea.bounds,
      allowReasonableStreetCrossings,
      signal,
    );
    if (walkGraphLoadResult.graph) {
      polygonCalculationResults = calculateWalkshedPolygons(
        walkGraphLoadResult.graph,
        calculationRequests,
      );
    }
  }

  if (walkGraphLoadResult?.aborted || signal?.aborted) return supersedeAll();

  if (!polygonCalculationResults) {
    // A whole-batch condition: either the shared request failed (transient) or
    // the shared area genuinely has no walkable network (no-data).
    const retryMs = walkGraphLoadResult?.transientFailure
      ? TRANSIENT_UNAVAILABLE_RETRY_MS
      : NO_DATA_UNAVAILABLE_RETRY_MS;
    const reason = walkGraphLoadResult?.transientFailure ? 'network' : 'no-data';
    await Promise.all(
      pending.map(async (entry) => {
        if (!isRequestCurrent(entry.request.stop.id, entry.stopRevision)) {
          results.set(entry.request.stop.id, { status: 'superseded' });
          return;
        }
        await setCachedWalkshedUnavailable(entry.cacheKey, retryMs);
        results.set(entry.request.stop.id, {
          status: 'unavailable',
          retryAfter: Date.now() + retryMs,
          reason,
        });
      }),
    );
    return results;
  }

  const calculationResultByStopId = new Map(
    polygonCalculationResults.map((result) => [result.stopId, result]),
  );
  await Promise.all(
    pending.map(async (entry) => {
      const { stop } = entry.request;
      const calculationResult = calculationResultByStopId.get(stop.id);
      if (!calculationResult) {
        results.set(stop.id, { status: 'superseded' });
        return;
      }
      const result = toWalkshedResult(calculationResult);
      if (result.status === 'polygon') {
        if (!isRequestCurrent(stop.id, entry.stopRevision)) {
          results.set(stop.id, { status: 'superseded' });
          return;
        }
        polygonCache.set(entry.cacheKey, result.polygon);
        await setCachedWalkshedPolygon(entry.cacheKey, result.polygon);
        results.set(stop.id, result);
        return;
      }

      if (isRequestCurrent(stop.id, entry.stopRevision)) {
        await setCachedWalkshedUnavailable(entry.cacheKey, NO_DATA_UNAVAILABLE_RETRY_MS);
      }
      results.set(stop.id, result);
    }),
  );

  return results;
}

export async function buildWalkshedPolygon(
  stop: Stop,
  radiusMeters: number,
  allowReasonableStreetCrossings = true,
  signal?: AbortSignal,
): Promise<WalkshedResult> {
  const results = await buildWalkshedPolygons(
    [{ stop, radiusMeters }],
    allowReasonableStreetCrossings,
    signal,
  );
  return results.get(stop.id) ?? { status: 'superseded' };
}
