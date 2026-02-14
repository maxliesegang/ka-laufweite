import {
  GRAPH_CACHE_COORD_PRECISION,
  MIN_BOUNDARY_POINTS_FOR_RELIABLE_POLYGON,
  START_NODE_CANDIDATE_LIMIT,
} from './constants';
import { buildWalkGraph, nearestNode, nearestNodeCandidates } from './graph';
import { fetchFootways } from './overpass';
import { buildPolygonFromStartNode } from './polygon';
import type { LatLng, WalkGraph } from './types';
import { getCachedWalkshedPolygon, setCachedWalkshedPolygon } from '../walkshed-cache';
import type { Stop } from '../types';

const graphCache = new Map<string, Promise<WalkGraph | null>>();
const polygonCache = new Map<string, LatLng[]>();

function graphCacheKey(stop: Stop, distanceMeters: number): string {
  return `${stop.lat.toFixed(GRAPH_CACHE_COORD_PRECISION)}:${stop.lon.toFixed(GRAPH_CACHE_COORD_PRECISION)}:${distanceMeters}`;
}

function polygonCacheKey(stop: Stop, distanceMeters: number): string {
  return `${stop.id}:${distanceMeters}`;
}

async function loadWalkGraph(stop: Stop, distanceMeters: number): Promise<WalkGraph | null> {
  const key = graphCacheKey(stop, distanceMeters);
  const cached = graphCache.get(key);
  if (cached) {
    return cached;
  }

  const pending = fetchFootways(stop.lat, stop.lon, distanceMeters)
    .then((response) => {
      if (!response) return null;
      return buildWalkGraph(response);
    })
    .catch(() => null);

  graphCache.set(key, pending);
  const graph = await pending;

  if (!graph) {
    graphCache.delete(key);
  }

  return graph;
}

export function clearWalkshedRuntimeCache(): void {
  graphCache.clear();
  polygonCache.clear();
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

  const persistedPolygon = getCachedWalkshedPolygon(key);
  if (persistedPolygon) {
    polygonCache.set(key, persistedPolygon);
    return persistedPolygon;
  }

  const graph = await loadWalkGraph(stop, distanceMeters);
  if (!graph) {
    return null;
  }

  const nearest = nearestNode(graph, stop.lat, stop.lon);
  if (!nearest) {
    return null;
  }

  const nearestAttempt = buildPolygonFromStartNode(
    graph,
    stop.lat,
    stop.lon,
    distanceMeters,
    nearest,
  );
  let polygon = nearestAttempt.polygon;

  if (nearestAttempt.boundaryPointCount < MIN_BOUNDARY_POINTS_FOR_RELIABLE_POLYGON) {
    const candidates = nearestNodeCandidates(graph, stop.lat, stop.lon, START_NODE_CANDIDATE_LIMIT);
    for (const candidate of candidates) {
      if (candidate.index === nearest.index) continue;

      const attempt = buildPolygonFromStartNode(
        graph,
        stop.lat,
        stop.lon,
        distanceMeters,
        candidate,
      );
      if (
        attempt.polygon &&
        attempt.boundaryPointCount >= MIN_BOUNDARY_POINTS_FOR_RELIABLE_POLYGON
      ) {
        polygon = attempt.polygon;
        break;
      }
    }
  }

  if (polygon) {
    polygonCache.set(key, polygon);
    setCachedWalkshedPolygon(key, polygon);
  }

  return polygon;
}
