import { describe, expect, it, vi } from 'vitest';

import type { GraphSeed, LatLng, OverpassResponse, WalkGraph } from './types';
import { encodeWalkshedPolygon } from './walkshed-codec';

const { calculateShortestPathsSpy } = vi.hoisted(() => ({ calculateShortestPathsSpy: vi.fn() }));

// Counts traversals without changing them: the point of the multi-radius entry
// point is that radii sharing effective seeds share one Dijkstra run.
vi.mock('./graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./graph')>();
  return {
    ...actual,
    calculateShortestPaths: (...args: Parameters<typeof actual.calculateShortestPaths>) => {
      calculateShortestPathsSpy(...args);
      return actual.calculateShortestPaths(...args);
    },
  };
});

const { buildWalkGraph, calculateShortestPaths, findNearestEdgeSeeds } = await import('./graph');
const { buildWalkshedPolygonFromSeeds, buildWalkshedPolygonsFromSeeds } = await import('./polygon');

const CENTER_LAT = 49.001;
const CENTER_LON = 8.001;

/** 3×3 lattice: rows ~111 m apart, columns ~73 m apart at this latitude. */
function gridGraph(): WalkGraph {
  const nodes = Array.from({ length: 9 }, (_, nodeOffset) => ({
    type: 'node' as const,
    id: nodeOffset + 1,
    lat: 49 + Math.floor(nodeOffset / 3) * 0.001,
    lon: 8 + (nodeOffset % 3) * 0.001,
  }));
  const networkData: OverpassResponse = {
    elements: [
      ...nodes,
      { type: 'way', id: 10, nodes: [1, 2, 3] },
      { type: 'way', id: 11, nodes: [4, 5, 6] },
      { type: 'way', id: 12, nodes: [7, 8, 9] },
      { type: 'way', id: 13, nodes: [1, 4, 7] },
      { type: 'way', id: 14, nodes: [2, 5, 8] },
      { type: 'way', id: 15, nodes: [3, 6, 9] },
    ],
  };
  const graph = buildWalkGraph(networkData);
  if (!graph) throw new Error('expected graph');
  return graph;
}

/**
 * Networks whose walkshed polygon is sensitive to the order boundary points are
 * collected in, one per mechanism that could otherwise leak that order into the
 * output. Found by searching random small networks; the geometry is arbitrary.
 */
const ORDER_SENSITIVE_CASES = [
  {
    name: 'points that hull ambiguously',
    coordinates: [
      [49.0033, 8.00045],
      [49.0042, 8.00045],
      [49.0021, 8.00045],
      [49.0033, 8.0036],
      [49.0039, 8.00405],
      [49.0039, 8.0045],
      [49.0036, 8.0063],
      [49.0024, 8.0009],
    ] as LatLng[],
    wayNodeIds: [
      [5, 4],
      [7, 2, 6],
      [2, 1, 6],
      [2, 7],
      [1, 2, 3],
    ],
    stop: [49.0009, 8.0013] as LatLng,
    radiusMeters: 500,
  },
  {
    name: 'near-coincident points sharing a deduplication cell',
    coordinates: [
      [49.0024, 8.0036],
      [49.0015, 8.00495],
      [49.0027, 8.00135],
      [49.003, 8.0045],
      [49.0033, 8.00315],
      [49.0009, 8.00135],
      [49.0003, 8.0036],
      [49.0006, 8.00045],
    ] as LatLng[],
    wayNodeIds: [
      [7, 6, 4, 2],
      [4, 1],
      [5, 8],
    ],
    stop: [49.0015, 8.0022] as LatLng,
    radiusMeters: 300,
  },
];

/** Build one case, optionally listing every way and its nodes back to front. */
function orderSensitiveGraph(
  coordinates: LatLng[],
  wayNodeIds: number[][],
  reversed: boolean,
): WalkGraph {
  const ways = wayNodeIds.map((nodeIds, wayOffset) => ({
    type: 'way' as const,
    id: 100 + wayOffset,
    nodes: reversed ? [...nodeIds].reverse() : nodeIds,
    tags: { highway: 'footway' },
  }));

  const graph = buildWalkGraph({
    elements: [
      ...coordinates.map(([lat, lon], nodeOffset) => ({
        type: 'node' as const,
        id: nodeOffset + 1,
        lat,
        lon,
      })),
      ...(reversed ? ways.reverse() : ways),
    ],
  });
  if (!graph) throw new Error('expected graph');
  return graph;
}

/** Distinct shortest-path distances reachable from `seeds`, ascending. */
function reachableDistances(graph: WalkGraph, seeds: GraphSeed[]): number[] {
  const { distanceByNodeIndex, settledNodeIndexes } = calculateShortestPaths(graph, seeds, 10_000);
  return [...new Set(settledNodeIndexes.map((node) => distanceByNodeIndex[node]))].sort(
    (a, b) => a - b,
  );
}

function expectCombinedMatchesIndependentCalculations(
  seeds: GraphSeed[],
  radiiMeters: number[],
): Map<number, ReturnType<typeof buildWalkshedPolygonFromSeeds>> {
  const graph = gridGraph();
  const combined = buildWalkshedPolygonsFromSeeds(
    graph,
    CENTER_LAT,
    CENTER_LON,
    radiiMeters,
    seeds,
  );

  for (const radiusMeters of radiiMeters) {
    const independent = buildWalkshedPolygonFromSeeds(
      graph,
      CENTER_LAT,
      CENTER_LON,
      radiusMeters,
      seeds,
    );
    expect(combined.get(radiusMeters)).toEqual(independent);
  }
  return combined;
}

describe('multi-radius walkshed polygons', () => {
  it('matches independent calculations for radii that share effective seeds', () => {
    expectCombinedMatchesIndependentCalculations(
      [{ nodeIndex: 4, initialDistanceMeters: 0 }],
      [100, 200, 250],
    );
  });

  it('matches independent calculations when larger radii activate more seeds', () => {
    expectCombinedMatchesIndependentCalculations(
      [
        { nodeIndex: 4, initialDistanceMeters: 0 },
        { nodeIndex: 8, initialDistanceMeters: 130 },
      ],
      [100, 200, 250],
    );
  });

  // Guards the assertions above against passing vacuously: if every radius
  // covered the whole grid, equality would hold no matter what the code did.
  it('produces genuinely different polygons per radius', () => {
    const combined = expectCombinedMatchesIndependentCalculations(
      [{ nodeIndex: 4, initialDistanceMeters: 0 }],
      [100, 200, 250],
    );

    const boundaryPointCounts = [100, 200, 250].map(
      (radiusMeters) => combined.get(radiusMeters)?.boundaryPointCount,
    );
    expect(new Set(boundaryPointCounts).size).toBeGreaterThan(1);
    expect(combined.get(100)?.polygon).not.toEqual(combined.get(250)?.polygon);
  });

  // The shared traversal stops scanning settled nodes once it passes the radius.
  // A node sitting exactly on the radius is still inside it.
  it('matches independent calculations when a node sits exactly on the radius', () => {
    const seeds: GraphSeed[] = [{ nodeIndex: 4, initialDistanceMeters: 0 }];
    const distances = reachableDistances(gridGraph(), seeds).filter((distance) => distance > 0);
    expect(distances.length).toBeGreaterThan(1);

    for (const exactRadiusMeters of distances) {
      expectCombinedMatchesIndependentCalculations(seeds, [
        exactRadiusMeters,
        distances[distances.length - 1],
      ]);
    }
  });

  it('runs one traversal per distinct effective seed set, not per radius', () => {
    const graph = gridGraph();

    calculateShortestPathsSpy.mockClear();
    buildWalkshedPolygonsFromSeeds(
      graph,
      CENTER_LAT,
      CENTER_LON,
      [100, 200, 250],
      [{ nodeIndex: 4, initialDistanceMeters: 0 }],
    );
    expect(calculateShortestPathsSpy).toHaveBeenCalledTimes(1);

    // Only radii of at least 130 + MIN_EFFECTIVE_WALK_DISTANCE_METERS can use the
    // second seed, so 100 forms its own group and 200/250 share the other.
    calculateShortestPathsSpy.mockClear();
    buildWalkshedPolygonsFromSeeds(
      graph,
      CENTER_LAT,
      CENTER_LON,
      [100, 200, 250],
      [
        { nodeIndex: 4, initialDistanceMeters: 0 },
        { nodeIndex: 8, initialDistanceMeters: 130 },
      ],
    );
    expect(calculateShortestPathsSpy).toHaveBeenCalledTimes(2);

    // Each group traverses to its largest radius only.
    const traversalRadii = calculateShortestPathsSpy.mock.calls.map((call) => call[2]);
    expect(new Set(traversalRadii)).toEqual(new Set([100, 250]));
  });

  // Reachability decides the polygon; the order points happen to be collected in
  // must not. Each case below hulls differently without that guarantee.
  it.each(ORDER_SENSITIVE_CASES)(
    'does not depend on collection order: $name',
    ({ coordinates, wayNodeIds, stop, radiusMeters }) => {
      const [stopLat, stopLon] = stop;
      const polygons = [false, true].map((reversed) => {
        const graph = orderSensitiveGraph(coordinates, wayNodeIds, reversed);
        return buildWalkshedPolygonFromSeeds(
          graph,
          stopLat,
          stopLon,
          radiusMeters,
          findNearestEdgeSeeds(graph, stopLat, stopLon),
        ).polygon;
      });

      // Compared as shipped, so the assertion is about the data, not float noise.
      expect(polygons[0]).not.toBeNull();
      expect(encodeWalkshedPolygon(polygons[1]!)).toEqual(encodeWalkshedPolygon(polygons[0]!));
    },
  );

  it('deduplicates repeated radii', () => {
    const graph = gridGraph();
    calculateShortestPathsSpy.mockClear();
    const combined = buildWalkshedPolygonsFromSeeds(
      graph,
      CENTER_LAT,
      CENTER_LON,
      [200, 200, 200],
      [{ nodeIndex: 4, initialDistanceMeters: 0 }],
    );

    expect(combined.size).toBe(1);
    expect(calculateShortestPathsSpy).toHaveBeenCalledTimes(1);
  });
});
