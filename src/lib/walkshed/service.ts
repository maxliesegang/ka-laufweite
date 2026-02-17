import {
  getCachedWalkshedPolygon,
  isWalkshedTemporarilyUnavailable,
  setCachedWalkshedPolygon,
  setCachedWalkshedUnavailable,
} from '../walkshed-cache';
import type { Stop } from '../types';
import {
  GRAPH_CACHE_COORD_PRECISION,
  MAX_START_NODE_FALLBACK_DISTANCE_DELTA_METERS,
  MIN_BOUNDARY_POINTS_FOR_RELIABLE_POLYGON,
  START_NODE_CANDIDATE_LIMIT,
} from './constants';
import { buildWalkGraph, nearestNodeCandidates } from './graph';
import { fetchFootways } from './overpass';
import { buildPolygonFromSeedNodes } from './polygon';
import type { LatLng, NearestNodeMatch, WalkGraph } from './types';

const TRANSIENT_UNAVAILABLE_RETRY_MS = 2 * 60 * 1_000;
const NO_DATA_UNAVAILABLE_RETRY_MS = 24 * 60 * 60 * 1_000;

interface GraphLoadResult {
  graph: WalkGraph | null;
  transientFailure: boolean;
}

const graphCache = new Map<string, Promise<GraphLoadResult>>();
const polygonCache = new Map<string, LatLng[]>();

function graphCacheKey(stop: Stop, distanceMeters: number): string {
  return `${stop.lat.toFixed(GRAPH_CACHE_COORD_PRECISION)}:${stop.lon.toFixed(GRAPH_CACHE_COORD_PRECISION)}:${distanceMeters}`;
}

function polygonCacheKey(stop: Stop, distanceMeters: number): string {
  return `${stop.id}:${distanceMeters}`;
}

function selectPreferredSeedNodes(candidates: NearestNodeMatch[]): NearestNodeMatch[] {
  if (candidates.length === 0) return [];
  const nearestDistance = candidates[0].distanceMeters;
  const maxSeedDistance = nearestDistance + MAX_START_NODE_FALLBACK_DISTANCE_DELTA_METERS;
  return candidates.filter((candidate) => candidate.distanceMeters <= maxSeedDistance);
}

async function loadWalkGraph(stop: Stop, distanceMeters: number): Promise<GraphLoadResult> {
  const key = graphCacheKey(stop, distanceMeters);
  const cached = graphCache.get(key);
  if (cached) {
    return cached;
  }

  const pending = fetchFootways(stop.lat, stop.lon, distanceMeters)
    .then((result): GraphLoadResult => {
      if (result.status !== 'ok') {
        return { graph: null, transientFailure: true };
      }

      return {
        graph: buildWalkGraph(result.response),
        transientFailure: false,
      };
    })
    .catch((): GraphLoadResult => ({ graph: null, transientFailure: true }));

  graphCache.set(key, pending);
  const graphResult = await pending;

  if (!graphResult.graph) {
    graphCache.delete(key);
  }

  return graphResult;
}

export function clearWalkshedRuntimeCache(): void {
  graphCache.clear();
  polygonCache.clear();
}

export function removeWalkshedRuntimeCacheForStop(stopId: string): void {
  const prefix = `${stopId}:`;
  for (const key of [...polygonCache.keys()]) {
    if (key.startsWith(prefix)) {
      polygonCache.delete(key);
    }
  }
}

export async function buildWalkshedPolygon(
  stop: Stop,
  distanceMeters: number,
): Promise<LatLng[] | null> {
  const key = polygonCacheKey(stop, distanceMeters);
  const inMemoryPolygon = polygonCache.get(key);
  if (inMemoryPolygon) {
    return inMemoryPolygon;
  }

  const persistedPolygon = await getCachedWalkshedPolygon(key);
  if (persistedPolygon) {
    polygonCache.set(key, persistedPolygon);
    return persistedPolygon;
  }

  if (await isWalkshedTemporarilyUnavailable(key)) {
    return null;
  }

  const graphResult = await loadWalkGraph(stop, distanceMeters);
  if (!graphResult.graph) {
    await setCachedWalkshedUnavailable(
      key,
      graphResult.transientFailure ? TRANSIENT_UNAVAILABLE_RETRY_MS : NO_DATA_UNAVAILABLE_RETRY_MS,
    );
    return null;
  }
  const graph = graphResult.graph;

  const candidates = nearestNodeCandidates(graph, stop.lat, stop.lon, START_NODE_CANDIDATE_LIMIT);
  if (candidates.length === 0) {
    await setCachedWalkshedUnavailable(key, NO_DATA_UNAVAILABLE_RETRY_MS);
    return null;
  }

  const preferredSeeds = selectPreferredSeedNodes(candidates);
  const preferredAttempt = buildPolygonFromSeedNodes(
    graph,
    stop.lat,
    stop.lon,
    distanceMeters,
    preferredSeeds,
  );
  let polygon = preferredAttempt.polygon;
  let bestBoundaryPointCount = preferredAttempt.boundaryPointCount;

  if (
    preferredAttempt.boundaryPointCount < MIN_BOUNDARY_POINTS_FOR_RELIABLE_POLYGON &&
    preferredSeeds.length < candidates.length
  ) {
    const expandedAttempt = buildPolygonFromSeedNodes(
      graph,
      stop.lat,
      stop.lon,
      distanceMeters,
      candidates,
    );
    if (expandedAttempt.polygon && expandedAttempt.boundaryPointCount > bestBoundaryPointCount) {
      polygon = expandedAttempt.polygon;
    }
  }

  if (polygon) {
    polygonCache.set(key, polygon);
    await setCachedWalkshedPolygon(key, polygon);
    return polygon;
  }

  await setCachedWalkshedUnavailable(key, NO_DATA_UNAVAILABLE_RETRY_MS);
  return null;
}
