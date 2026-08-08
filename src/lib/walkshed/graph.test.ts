import { describe, expect, it } from 'vitest';
import { buildWalkGraph, calculateShortestPathDistances, findNearestEdgeSeeds } from './graph';
import type { OverpassResponse } from './types';

function lineGraph(): NonNullable<ReturnType<typeof buildWalkGraph>> {
  const networkData: OverpassResponse = {
    elements: [
      { type: 'node', id: 1, lat: 49, lon: 8 },
      { type: 'node', id: 2, lat: 49, lon: 8.002 },
      { type: 'way', id: 10, nodes: [1, 2] },
    ],
  };
  const graph = buildWalkGraph(networkData);
  if (!graph) throw new Error('expected graph');
  return graph;
}

describe('walk graph', () => {
  it('adds short perpendicular crossings throughout the graph when enabled', () => {
    const networkData: OverpassResponse = {
      elements: [
        { type: 'node', id: 1, lat: 49.00008, lon: 8 },
        { type: 'node', id: 2, lat: 49.00008, lon: 8.001 },
        { type: 'node', id: 3, lat: 48.99992, lon: 8 },
        { type: 'node', id: 4, lat: 48.99992, lon: 8.001 },
        { type: 'node', id: 5, lat: 49, lon: 7.999 },
        { type: 'node', id: 6, lat: 49, lon: 8.002 },
        { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'footway' } },
        { type: 'way', id: 11, nodes: [3, 4], tags: { highway: 'footway' } },
        { type: 'way', id: 12, nodes: [5, 6], tags: { highway: 'residential' } },
      ],
    };
    const mappedOnly = buildWalkGraph(networkData, false);
    const withCrossings = buildWalkGraph(networkData, true);
    if (!mappedOnly || !withCrossings) throw new Error('expected graphs');

    const mappedDistances = calculateShortestPathDistances(
      mappedOnly,
      [{ nodeIndex: 0, initialDistanceMeters: 0 }],
      100,
    );
    const crossingDistances = calculateShortestPathDistances(
      withCrossings,
      [{ nodeIndex: 0, initialDistanceMeters: 0 }],
      100,
    );
    expect(mappedDistances[2]).toBe(Number.POSITIVE_INFINITY);
    expect(crossingDistances[2]).toBeLessThan(30);
  });

  it('does not add a crossing parallel to an edge the ways already provide', () => {
    // The two footway nodes are ~20 m apart and already joined by way 10, while
    // way 11 crosses perpendicularly between them — a valid crossing candidate.
    const networkData: OverpassResponse = {
      elements: [
        { type: 'node', id: 1, lat: 49, lon: 8 },
        { type: 'node', id: 2, lat: 49, lon: 8.00028 },
        { type: 'node', id: 3, lat: 48.9999, lon: 8.00014 },
        { type: 'node', id: 4, lat: 49.0001, lon: 8.00014 },
        { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'footway' } },
        { type: 'way', id: 11, nodes: [3, 4], tags: { highway: 'residential' } },
      ],
    };
    const graph = buildWalkGraph(networkData, true);
    if (!graph) throw new Error('expected graph');

    for (const edges of graph.adjacency) {
      const neighbors = edges.map((edge) => edge.toNodeIndex);
      expect(new Set(neighbors).size).toBe(neighbors.length);
    }
  });

  it('projects a stop onto one edge and charges along-edge access costs', () => {
    const graph = lineGraph();
    expect(graph.edgeIndex).toBeDefined();
    const seeds = findNearestEdgeSeeds(graph, 49, 8.001);
    expect(seeds).toHaveLength(2);
    expect(seeds[0].initialDistanceMeters).toBeGreaterThan(70);
    expect(seeds[0].initialDistanceMeters).toBeLessThan(80);
    expect(seeds[1].initialDistanceMeters).toBeGreaterThan(70);
    expect(seeds[1].initialDistanceMeters).toBeLessThan(80);
  });

  // A stop equidistant from two edges must not depend on which one the segment
  // index happens to yield first: node indexes follow the order ways arrive in.
  it('breaks equidistant snap ties by geometry, not by way order', () => {
    const buildMirroredGraph = (reversed: boolean) => {
      const ways = [
        { type: 'way' as const, id: 10, nodes: [1, 2], tags: { highway: 'footway' } },
        { type: 'way' as const, id: 11, nodes: [3, 4], tags: { highway: 'footway' } },
      ];
      const graph = buildWalkGraph({
        elements: [
          // Two parallel edges mirrored about lon 8. The offsets are powers of two
          // so the mirrored projections are equidistant to the bit, rather than
          // merely close enough for float noise to decide the winner.
          { type: 'node', id: 1, lat: 49, lon: 7.99993896484375 },
          { type: 'node', id: 2, lat: 49.00390625, lon: 7.99993896484375 },
          { type: 'node', id: 3, lat: 49, lon: 8.00006103515625 },
          { type: 'node', id: 4, lat: 49.00390625, lon: 8.00006103515625 },
          ...(reversed ? ways.reverse() : ways),
        ],
      });
      if (!graph) throw new Error('expected graph');
      return graph;
    };

    const snappedTo = (reversed: boolean) => {
      const graph = buildMirroredGraph(reversed);
      const seeds = findNearestEdgeSeeds(graph, 49.001953125, 8);
      expect(seeds).toHaveLength(2);
      return seeds.map((seed) => graph.nodes[seed.nodeIndex]).sort((a, b) => a[0] - b[0]);
    };

    // Both orders must snap to the same edge, and to the lower-lon one: the rule
    // is "smallest endpoint coordinates win", so the result is also predictable.
    expect(snappedTo(false)).toEqual([
      [49, 7.99993896484375],
      [49.00390625, 7.99993896484375],
    ]);
    expect(snappedTo(true)).toEqual(snappedTo(false));
  });

  it('does not seed a disconnected nearby edge as an additional source', () => {
    const graph = lineGraph();
    graph.nodes.push([49.0001, 8], [49.0001, 8.002]);
    graph.adjacency.push(
      [{ toNodeIndex: 3, distanceMeters: 146 }],
      [{ toNodeIndex: 2, distanceMeters: 146 }],
    );
    const seeds = findNearestEdgeSeeds(graph, 49.00001, 8.001);
    expect(new Set(seeds.map((seed) => seed.nodeIndex))).toEqual(new Set([0, 1]));
  });

  it('bridges a stub stop to a nearby substantial component', () => {
    const chainNodes = Array.from({ length: 31 }, (_, i) => i + 1);
    const networkData: OverpassResponse = {
      elements: [
        // Substantial component: a 31-node footway chain along lat 49.0000.
        ...chainNodes.map((id, i) => ({
          type: 'node' as const,
          id,
          lat: 49.0,
          lon: 8.0 + i * 0.0002,
        })),
        { type: 'way', id: 1000, nodes: chainNodes, tags: { highway: 'footway' } },
        // Tiny disconnected stub ~1 m from the stop, ~32 m from the chain.
        { type: 'node', id: 100, lat: 49.00028, lon: 8.003 },
        { type: 'node', id: 101, lat: 49.00028, lon: 8.00305 },
        { type: 'way', id: 1001, nodes: [100, 101], tags: { highway: 'footway' } },
      ],
    };
    const graph = buildWalkGraph(networkData, false);
    if (!graph) throw new Error('expected graph');
    const { componentSizes, componentIdByNode } = graph;
    if (!componentSizes || !componentIdByNode) throw new Error('expected components');
    expect(Math.max(...componentSizes)).toBe(31);

    const seeds = findNearestEdgeSeeds(graph, 49.00029, 8.003);
    const substantialComponentId = componentSizes.indexOf(31);
    const seedsInSubstantial = seeds.filter(
      (seed) => componentIdByNode[seed.nodeIndex] === substantialComponentId,
    );
    expect(seedsInSubstantial.length).toBeGreaterThan(0);
  });

  it('respects the distance budget in Dijkstra traversal', () => {
    const graph = lineGraph();
    const distanceByNodeIndex = calculateShortestPathDistances(
      graph,
      [{ nodeIndex: 0, initialDistanceMeters: 10 }],
      100,
    );
    expect(distanceByNodeIndex[0]).toBe(10);
    expect(distanceByNodeIndex[1]).toBe(Number.POSITIVE_INFINITY);
  });
});
