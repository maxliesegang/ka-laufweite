import concaveman from 'concaveman';
import {
  CONCAVE_HULL_CONCAVITY,
  CONCAVE_HULL_LENGTH_THRESHOLD_METERS,
  LOCAL_POINT_KEY_DECIMALS,
  MIN_EFFECTIVE_WALK_DISTANCE_METERS,
} from './constants';
import { METERS_PER_LAT_DEGREE, metersPerLonDegree } from './geo';
import { calculateShortestPaths } from './graph';
import type { GraphSeed, LatLng, LocalPoint, WalkGraph, WalkshedPolygonAttempt } from './types';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function interpolate(a: LatLng, b: LatLng, t: number): LatLng {
  const clamped = clamp01(t);
  return [a[0] + (b[0] - a[0]) * clamped, a[1] + (b[1] - a[1]) * clamped];
}

/**
 * Outline material for the reachable subgraph: every settled node, plus the
 * point where an edge leaving that node runs out of remaining distance.
 *
 * Points may repeat — `polygonFromBoundaryPoints` deduplicates in projected
 * meters anyway, so this loop stays free of per-point keys and allocations. It
 * runs once per stop and radius over the whole reachable subgraph.
 */
function collectReachableBoundaryPoints(
  graph: WalkGraph,
  distanceByNodeIndex: Float64Array,
  radiusMeters: number,
  settledNodeIndexes: number[],
): LatLng[] {
  const boundaryPoints: LatLng[] = [];

  for (const fromNodeIndex of settledNodeIndexes) {
    const fromDistanceMeters = distanceByNodeIndex[fromNodeIndex];
    // Dijkstra settles nodes in nondecreasing distance order. A shared traversal
    // can therefore stop scanning as soon as it passes this radius.
    if (!Number.isFinite(fromDistanceMeters) || fromDistanceMeters > radiusMeters) break;

    const fromPoint = graph.nodes[fromNodeIndex];
    const fromRemainingMeters = radiusMeters - fromDistanceMeters;
    boundaryPoints.push(fromPoint);

    for (const edge of graph.adjacency[fromNodeIndex]) {
      const { toNodeIndex, distanceMeters: edgeDistanceMeters } = edge;
      const toDistanceMeters = distanceByNodeIndex[toNodeIndex];
      const isToNodeReachable =
        Number.isFinite(toDistanceMeters) && toDistanceMeters <= radiusMeters;
      // Every reachable node is settled exactly once, so an edge between two of
      // them is scanned from both ends: keep the lower-index end and skip the
      // mirror. Edges to unreachable nodes are only ever seen from this end.
      if (isToNodeReachable && toNodeIndex < fromNodeIndex) continue;

      const toPoint = graph.nodes[toNodeIndex];
      if (fromRemainingMeters > 0 && fromRemainingMeters < edgeDistanceMeters) {
        boundaryPoints.push(
          interpolate(fromPoint, toPoint, fromRemainingMeters / edgeDistanceMeters),
        );
      }

      if (isToNodeReachable) {
        const toRemainingMeters = radiusMeters - toDistanceMeters;
        if (toRemainingMeters > 0 && toRemainingMeters < edgeDistanceMeters) {
          boundaryPoints.push(
            interpolate(toPoint, fromPoint, toRemainingMeters / edgeDistanceMeters),
          );
        }
      }
    }
  }

  return boundaryPoints;
}

function toLocalMeters(point: LatLng, centerLat: number, centerLon: number): LocalPoint {
  return [
    (point[1] - centerLon) * metersPerLonDegree(centerLat),
    (point[0] - centerLat) * METERS_PER_LAT_DEGREE,
  ];
}

function fromLocalMeters(point: LocalPoint, centerLat: number, centerLon: number): LatLng {
  return [
    centerLat + point[1] / METERS_PER_LAT_DEGREE,
    centerLon + point[0] / metersPerLonDegree(centerLat),
  ];
}

function localPointKey(point: LocalPoint): string {
  return `${point[0].toFixed(LOCAL_POINT_KEY_DECIMALS)}:${point[1].toFixed(LOCAL_POINT_KEY_DECIMALS)}`;
}

const LOCAL_POINT_KEY_GRID = 10 ** LOCAL_POINT_KEY_DECIMALS;

/** The one coordinate every point sharing a `localPointKey` collapses to. */
function snapToLocalPointKeyGrid(point: LocalPoint): LocalPoint {
  return [
    Math.round(point[0] * LOCAL_POINT_KEY_GRID) / LOCAL_POINT_KEY_GRID,
    Math.round(point[1] * LOCAL_POINT_KEY_GRID) / LOCAL_POINT_KEY_GRID,
  ];
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
    // Snap before deduplicating rather than keeping whichever representative arrived
    // first: two collection orders otherwise retain coordinates that differ below a
    // centimetre, which is enough to change what concaveman does below.
    const localPoint = snapToLocalPointKeyGrid(toLocalMeters(point, centerLat, centerLon));
    const key = localPointKey(localPoint);
    if (seen.has(key)) continue;
    seen.add(key);
    localPoints.push(localPoint);
  }

  if (localPoints.length < 3) return null;

  // Some point sets admit more than one valid concave hull, and concaveman picks
  // between them by input order — so the same reachable network could yield a
  // different polygon purely because points were collected in another sequence.
  // Sorting makes the hull a function of the point set alone, which keeps output
  // stable across refactors of the collection loop above.
  localPoints.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

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

/** Radii that share one effective seed set, and therefore one Dijkstra traversal. */
interface SharedTraversalGroup {
  effectiveSeeds: GraphSeed[];
  radiiMeters: number[];
}

function effectiveSeedsForRadius(seeds: GraphSeed[], radiusMeters: number): GraphSeed[] {
  return seeds.filter(
    (seed) => radiusMeters - seed.initialDistanceMeters >= MIN_EFFECTIVE_WALK_DISTANCE_METERS,
  );
}

function effectiveSeedsKey(effectiveSeeds: GraphSeed[]): string {
  return effectiveSeeds.map((seed) => `${seed.nodeIndex}:${seed.initialDistanceMeters}`).join('|');
}

function buildWalkshedPolygonFromShortestPaths(
  graph: WalkGraph,
  centerLat: number,
  centerLon: number,
  radiusMeters: number,
  distanceByNodeIndex: Float64Array,
  settledNodeIndexes: number[],
): WalkshedPolygonAttempt {
  const boundaryPoints = collectReachableBoundaryPoints(
    graph,
    distanceByNodeIndex,
    radiusMeters,
    settledNodeIndexes,
  );
  // This remains a visual hull approximation of the reachable network. Do not
  // force the stop into it: the straight snap connector may cross a real barrier.

  return {
    polygon: polygonFromBoundaryPoints(boundaryPoints, centerLat, centerLon),
    boundaryPointCount: boundaryPoints.length,
  };
}

/**
 * Build several radii for one stop while reusing Dijkstra results. Radii with
 * the same effective graph seeds share one traversal up to their largest
 * distance; seed groups remain separate so every result matches an independent
 * single-radius calculation exactly.
 */
export function buildWalkshedPolygonsFromSeeds(
  graph: WalkGraph,
  centerLat: number,
  centerLon: number,
  radiiMeters: readonly number[],
  seeds: GraphSeed[],
): Map<number, WalkshedPolygonAttempt> {
  const attemptsByRadiusMeters = new Map<number, WalkshedPolygonAttempt>();
  const traversalGroupsBySeedKey = new Map<string, SharedTraversalGroup>();
  const uniqueRadiiMeters = [...new Set(radiiMeters)].sort((a, b) => a - b);

  for (const radiusMeters of uniqueRadiiMeters) {
    const effectiveSeeds = effectiveSeedsForRadius(seeds, radiusMeters);
    if (effectiveSeeds.length === 0) {
      attemptsByRadiusMeters.set(radiusMeters, { polygon: null, boundaryPointCount: 0 });
      continue;
    }

    const seedKey = effectiveSeedsKey(effectiveSeeds);
    const traversalGroup = traversalGroupsBySeedKey.get(seedKey);
    if (traversalGroup) traversalGroup.radiiMeters.push(radiusMeters);
    else traversalGroupsBySeedKey.set(seedKey, { effectiveSeeds, radiiMeters: [radiusMeters] });
  }

  for (const {
    effectiveSeeds,
    radiiMeters: groupRadiiMeters,
  } of traversalGroupsBySeedKey.values()) {
    const largestRadiusMeters = groupRadiiMeters[groupRadiiMeters.length - 1];
    const { distanceByNodeIndex, settledNodeIndexes } = calculateShortestPaths(
      graph,
      effectiveSeeds,
      largestRadiusMeters,
    );

    for (const radiusMeters of groupRadiiMeters) {
      attemptsByRadiusMeters.set(
        radiusMeters,
        buildWalkshedPolygonFromShortestPaths(
          graph,
          centerLat,
          centerLon,
          radiusMeters,
          distanceByNodeIndex,
          settledNodeIndexes,
        ),
      );
    }
  }

  return attemptsByRadiusMeters;
}

export function buildWalkshedPolygonFromSeeds(
  graph: WalkGraph,
  centerLat: number,
  centerLon: number,
  radiusMeters: number,
  seeds: GraphSeed[],
): WalkshedPolygonAttempt {
  const effectiveSeeds = effectiveSeedsForRadius(seeds, radiusMeters);
  if (effectiveSeeds.length === 0) {
    return { polygon: null, boundaryPointCount: 0 };
  }

  const { distanceByNodeIndex, settledNodeIndexes } = calculateShortestPaths(
    graph,
    effectiveSeeds,
    radiusMeters,
  );
  return buildWalkshedPolygonFromShortestPaths(
    graph,
    centerLat,
    centerLon,
    radiusMeters,
    distanceByNodeIndex,
    settledNodeIndexes,
  );
}
