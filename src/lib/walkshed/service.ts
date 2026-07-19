import {
  getCachedWalkshedPolygon,
  getWalkshedCacheResetMarker,
  getWalkshedUnavailableRetryAfter,
  setCachedWalkshedPolygon,
  setCachedWalkshedUnavailable,
} from '../walkshed-cache';
import type { Stop } from '../types';
import { GRAPH_CACHE_COORD_PRECISION } from './constants';
import { walkshedCacheKey, walkshedCacheKeyPrefixForStop } from './cache-key';
import { buildWalkGraph, nearestEdgeSeeds } from './graph';
import { fetchFootways } from './overpass';
import { buildPolygonFromSeedNodes } from './polygon';
import type { LatLng, WalkGraph } from './types';

const TRANSIENT_UNAVAILABLE_RETRY_MS = 2 * 60 * 1_000;
const NO_DATA_UNAVAILABLE_RETRY_MS = 24 * 60 * 60 * 1_000;

interface GraphLoadResult {
  graph: WalkGraph | null;
  transientFailure: boolean;
  aborted: boolean;
}

const graphCache = new Map<string, Promise<GraphLoadResult>>();
const polygonCache = new Map<string, LatLng[]>();
let cacheEpoch = 0;
const stopRevisions = new Map<string, number>();

function graphCacheKey(
  stop: Stop,
  distanceMeters: number,
  allowReasonableStreetCrossings: boolean,
): string {
  return `${stop.lat.toFixed(GRAPH_CACHE_COORD_PRECISION)}:${stop.lon.toFixed(GRAPH_CACHE_COORD_PRECISION)}:${distanceMeters}:${allowReasonableStreetCrossings}`;
}

function polygonCacheKey(
  stop: Stop,
  distanceMeters: number,
  allowReasonableStreetCrossings: boolean,
): string {
  return walkshedCacheKey(
    stop.id,
    distanceMeters,
    stop.lat,
    stop.lon,
    allowReasonableStreetCrossings,
  );
}

async function loadWalkGraph(
  stop: Stop,
  distanceMeters: number,
  allowReasonableStreetCrossings: boolean,
  signal?: AbortSignal,
): Promise<GraphLoadResult> {
  const graphKey = graphCacheKey(stop, distanceMeters, allowReasonableStreetCrossings);
  const cached = graphCache.get(graphKey);
  if (cached) {
    return cached;
  }

  const pending = fetchFootways(stop.lat, stop.lon, distanceMeters, signal)
    .then((result): GraphLoadResult => {
      if (result.status !== 'ok') {
        return { graph: null, transientFailure: true, aborted: false };
      }

      return {
        graph: buildWalkGraph(result.response, allowReasonableStreetCrossings),
        transientFailure: false,
        aborted: false,
      };
    })
    .catch((): GraphLoadResult => ({
      graph: null,
      transientFailure: !signal?.aborted,
      aborted: signal?.aborted ?? false,
    }));

  graphCache.set(graphKey, pending);
  const graphResult = await pending;

  if (!graphResult.graph) {
    graphCache.delete(graphKey);
  }

  return graphResult;
}

export function clearWalkshedRuntimeCache(): void {
  cacheEpoch += 1;
  graphCache.clear();
  polygonCache.clear();
}

export function removeWalkshedRuntimeCacheForStop(stopId: string): void {
  stopRevisions.set(stopId, (stopRevisions.get(stopId) ?? 0) + 1);
  const prefix = walkshedCacheKeyPrefixForStop(stopId);
  for (const cacheKey of [...polygonCache.keys()]) {
    if (cacheKey.startsWith(prefix)) {
      polygonCache.delete(cacheKey);
    }
  }
}

/**
 * Fast path: return an already-computed polygon from the in-memory or persistent
 * cache without ever touching the network. Returns null on a cache miss so the
 * caller can decide whether to schedule the (slow) network compute separately.
 *
 * Keeping this network-free lets the overlay render cached stops immediately
 * instead of queueing them behind uncached neighbours that need Overpass fetches.
 */
export async function peekCachedWalkshedPolygon(
  stop: Stop,
  distanceMeters: number,
  allowReasonableStreetCrossings = true,
): Promise<LatLng[] | null> {
  const cacheKey = polygonCacheKey(stop, distanceMeters, allowReasonableStreetCrossings);
  const inMemoryPolygon = polygonCache.get(cacheKey);
  if (inMemoryPolygon) {
    return inMemoryPolygon;
  }

  const persistedPolygon = await getCachedWalkshedPolygon(cacheKey);
  if (persistedPolygon) {
    polygonCache.set(cacheKey, persistedPolygon);
    return persistedPolygon;
  }

  return null;
}

export async function buildWalkshedPolygon(
  stop: Stop,
  distanceMeters: number,
  allowReasonableStreetCrossings = true,
  signal?: AbortSignal,
): Promise<WalkshedBuildResult> {
  const calculationEpoch = cacheEpoch;
  const persistentCacheMarker = getWalkshedCacheResetMarker();
  const stopRevision = stopRevisions.get(stop.id) ?? 0;
  const isCurrent = () =>
    calculationEpoch === cacheEpoch &&
    stopRevision === (stopRevisions.get(stop.id) ?? 0) &&
    persistentCacheMarker === getWalkshedCacheResetMarker();
  const cachedPolygon = await peekCachedWalkshedPolygon(
    stop,
    distanceMeters,
    allowReasonableStreetCrossings,
  );
  if (cachedPolygon) {
    return { status: 'polygon', polygon: cachedPolygon };
  }

  const cacheKey = polygonCacheKey(stop, distanceMeters, allowReasonableStreetCrossings);
  const cachedRetryAfter = await getWalkshedUnavailableRetryAfter(cacheKey);
  if (cachedRetryAfter !== null) {
    return { status: 'unavailable', retryAfter: cachedRetryAfter, reason: 'cached' };
  }

  const graphResult = await loadWalkGraph(
    stop,
    distanceMeters,
    allowReasonableStreetCrossings,
    signal,
  );
  if (graphResult.aborted) return { status: 'superseded' };
  if (!graphResult.graph) {
    const retryMs = graphResult.transientFailure
      ? TRANSIENT_UNAVAILABLE_RETRY_MS
      : NO_DATA_UNAVAILABLE_RETRY_MS;
    if (isCurrent()) await setCachedWalkshedUnavailable(cacheKey, retryMs);
    return {
      status: 'unavailable',
      retryAfter: Date.now() + retryMs,
      reason: graphResult.transientFailure ? 'network' : 'no-data',
    };
  }
  const graph = graphResult.graph;

  const seeds = nearestEdgeSeeds(graph, stop.lat, stop.lon);
  if (seeds.length === 0) {
    if (isCurrent()) await setCachedWalkshedUnavailable(cacheKey, NO_DATA_UNAVAILABLE_RETRY_MS);
    return {
      status: 'unavailable',
      retryAfter: Date.now() + NO_DATA_UNAVAILABLE_RETRY_MS,
      reason: 'no-nearby-edge',
    };
  }

  const polygon = buildPolygonFromSeedNodes(
    graph,
    stop.lat,
    stop.lon,
    distanceMeters,
    seeds,
  ).polygon;

  if (polygon) {
    if (!isCurrent()) return { status: 'superseded' };
    polygonCache.set(cacheKey, polygon);
    await setCachedWalkshedPolygon(cacheKey, polygon);
    return { status: 'polygon', polygon };
  }

  if (isCurrent()) await setCachedWalkshedUnavailable(cacheKey, NO_DATA_UNAVAILABLE_RETRY_MS);
  return {
    status: 'unavailable',
    retryAfter: Date.now() + NO_DATA_UNAVAILABLE_RETRY_MS,
    reason: 'invalid-polygon',
  };
}

export type WalkshedBuildResult =
  | { status: 'polygon'; polygon: LatLng[] }
  | {
      status: 'unavailable';
      retryAfter: number;
      reason: 'cached' | 'network' | 'no-data' | 'no-nearby-edge' | 'invalid-polygon';
    }
  | { status: 'superseded' };
