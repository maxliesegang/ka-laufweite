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
