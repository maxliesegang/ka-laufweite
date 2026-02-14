import concaveman from 'concaveman';
import {
  CONCAVE_HULL_CONCAVITY,
  CONCAVE_HULL_LENGTH_THRESHOLD_METERS,
  LOCAL_POINT_KEY_DECIMALS,
  MIN_EFFECTIVE_WALK_DISTANCE_METERS,
  POINT_KEY_DECIMALS,
} from './constants';
import { metersPerLonDegree } from './geo';
import { shortestPathDistances } from './graph';
import type { LatLng, LocalPoint, NearestNodeMatch, WalkGraph, WalkshedAttempt } from './types';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function interpolate(a: LatLng, b: LatLng, t: number): LatLng {
  const clamped = clamp01(t);
  return [a[0] + (b[0] - a[0]) * clamped, a[1] + (b[1] - a[1]) * clamped];
}

function pointKey(point: LatLng): string {
  return `${point[0].toFixed(POINT_KEY_DECIMALS)}:${point[1].toFixed(POINT_KEY_DECIMALS)}`;
}

function addUniquePoint(points: LatLng[], seen: Set<string>, point: LatLng): void {
  const key = pointKey(point);
  if (seen.has(key)) return;
  seen.add(key);
  points.push(point);
}

function collectReachableBoundaryPoints(
  graph: WalkGraph,
  distances: Float64Array,
  maxDistance: number,
): LatLng[] {
  const points: LatLng[] = [];
  const seen = new Set<string>();

  for (let from = 0; from < graph.adjacency.length; from += 1) {
    const fromDistance = distances[from];
    const fromReachable = Number.isFinite(fromDistance) && fromDistance <= maxDistance;

    for (const edge of graph.adjacency[from]) {
      const to = edge.to;
      if (from > to) continue;

      const toDistance = distances[to];
      const toReachable = Number.isFinite(toDistance) && toDistance <= maxDistance;
      if (!fromReachable && !toReachable) continue;

      const fromPoint = graph.nodes[from];
      const toPoint = graph.nodes[to];

      if (fromReachable) {
        addUniquePoint(points, seen, fromPoint);

        const fromRemaining = maxDistance - fromDistance;
        if (fromRemaining > 0 && fromRemaining < edge.distance) {
          const t = fromRemaining / edge.distance;
          addUniquePoint(points, seen, interpolate(fromPoint, toPoint, t));
        }
      }

      if (toReachable) {
        addUniquePoint(points, seen, toPoint);

        const toRemaining = maxDistance - toDistance;
        if (toRemaining > 0 && toRemaining < edge.distance) {
          const t = toRemaining / edge.distance;
          addUniquePoint(points, seen, interpolate(toPoint, fromPoint, t));
        }
      }
    }
  }

  return points;
}

function toLocalMeters(point: LatLng, centerLat: number, centerLon: number): LocalPoint {
  return [(point[1] - centerLon) * metersPerLonDegree(centerLat), (point[0] - centerLat) * 111_320];
}

function fromLocalMeters(point: LocalPoint, centerLat: number, centerLon: number): LatLng {
  return [centerLat + point[1] / 111_320, centerLon + point[0] / metersPerLonDegree(centerLat)];
}

function localPointKey(point: LocalPoint): string {
  return `${point[0].toFixed(LOCAL_POINT_KEY_DECIMALS)}:${point[1].toFixed(LOCAL_POINT_KEY_DECIMALS)}`;
}

function cross(o: LocalPoint, a: LocalPoint, b: LocalPoint): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function convexHull(points: LocalPoint[]): LocalPoint[] {
  if (points.length <= 3) return points;

  const sorted = [...points].sort((a, b) => {
    if (a[0] !== b[0]) return a[0] - b[0];
    return a[1] - b[1];
  });

  const lower: LocalPoint[] = [];
  for (const point of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0
    ) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper: LocalPoint[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function dropDuplicateClosingPoint(points: LocalPoint[]): LocalPoint[] {
  if (points.length < 2) return points;
  const first = points[0];
  const last = points[points.length - 1];

  if (first[0] === last[0] && first[1] === last[1]) {
    return points.slice(0, -1);
  }

  return points;
}

function asLocalPoint(value: number[]): LocalPoint | null {
  if (value.length < 2) return null;
  const x = value[0];
  const y = value[1];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

function polygonFromBoundaryPoints(
  boundaryPoints: LatLng[],
  centerLat: number,
  centerLon: number,
): LatLng[] | null {
  const seen = new Set<string>();
  const localPoints: LocalPoint[] = [];

  for (const point of boundaryPoints) {
    const localPoint = toLocalMeters(point, centerLat, centerLon);
    const key = localPointKey(localPoint);
    if (seen.has(key)) continue;
    seen.add(key);
    localPoints.push(localPoint);
  }

  if (localPoints.length < 3) return null;

  const concaveHullRaw = concaveman(
    localPoints,
    CONCAVE_HULL_CONCAVITY,
    CONCAVE_HULL_LENGTH_THRESHOLD_METERS,
  );
  const concaveHull = dropDuplicateClosingPoint(
    concaveHullRaw
      .map((point) => asLocalPoint(point))
      .filter((point): point is LocalPoint => point !== null),
  );

  if (concaveHull.length >= 3) {
    return concaveHull.map((point) => fromLocalMeters(point, centerLat, centerLon));
  }

  const fallbackHull = convexHull(localPoints);
  if (fallbackHull.length < 3) return null;
  return fallbackHull.map((point) => fromLocalMeters(point, centerLat, centerLon));
}

export function buildPolygonFromStartNode(
  graph: WalkGraph,
  centerLat: number,
  centerLon: number,
  distanceMeters: number,
  start: NearestNodeMatch,
): WalkshedAttempt {
  const effectiveDistance = distanceMeters - start.distanceMeters;
  if (effectiveDistance < MIN_EFFECTIVE_WALK_DISTANCE_METERS) {
    return { polygon: null, boundaryPointCount: 0 };
  }

  const distances = shortestPathDistances(graph, start.index, effectiveDistance);
  const boundaryPoints = collectReachableBoundaryPoints(graph, distances, effectiveDistance);
  const boundaryPointSet = new Set(boundaryPoints.map((point) => pointKey(point)));
  addUniquePoint(boundaryPoints, boundaryPointSet, [centerLat, centerLon]);

  return {
    polygon: polygonFromBoundaryPoints(boundaryPoints, centerLat, centerLon),
    boundaryPointCount: boundaryPoints.length,
  };
}
