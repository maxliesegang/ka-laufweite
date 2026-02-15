import { SNAP_DISTANCE_METERS } from './constants';
import { haversineMeters } from './geo';
import { MinPriorityQueue } from './priority-queue';
import type { LatLng, NearestNodeMatch, OverpassResponse, WalkGraph } from './types';

export function buildWalkGraph(response: OverpassResponse): WalkGraph | null {
  const nodeById = new Map<number, LatLng>();
  const wayNodeIds = new Set<number>();
  const ways = response.elements.filter((element) => element.type === 'way');

  for (const element of response.elements) {
    if (element.type === 'node') {
      nodeById.set(element.id, [element.lat, element.lon]);
      continue;
    }

    for (const nodeId of element.nodes) {
      wayNodeIds.add(nodeId);
    }
  }

  if (ways.length === 0 || wayNodeIds.size === 0) {
    return null;
  }

  const nodes: LatLng[] = [];
  const nodeIndexById = new Map<number, number>();
  for (const nodeId of wayNodeIds) {
    const latLng = nodeById.get(nodeId);
    if (!latLng) continue;
    nodeIndexById.set(nodeId, nodes.length);
    nodes.push(latLng);
  }

  if (nodes.length < 2) return null;

  const adjacency = nodes.map(() => [] as Array<{ to: number; distance: number }>);
  const dedupEdges = new Set<string>();

  for (const way of ways) {
    for (let i = 1; i < way.nodes.length; i += 1) {
      const fromNodeId = way.nodes[i - 1];
      const toNodeId = way.nodes[i];
      const from = nodeIndexById.get(fromNodeId);
      const to = nodeIndexById.get(toNodeId);
      if (from === undefined || to === undefined || from === to) continue;

      const a = Math.min(from, to);
      const b = Math.max(from, to);
      const key = `${a}:${b}`;
      if (dedupEdges.has(key)) continue;
      dedupEdges.add(key);

      const distance = haversineMeters(nodes[from], nodes[to]);
      if (!Number.isFinite(distance) || distance <= 0) continue;

      adjacency[from].push({ to, distance });
      adjacency[to].push({ to: from, distance });
    }
  }

  return { nodes, adjacency };
}

export function nearestNodeCandidates(
  graph: WalkGraph,
  lat: number,
  lon: number,
  limit: number,
): NearestNodeMatch[] {
  const point: LatLng = [lat, lon];
  const matches: NearestNodeMatch[] = [];

  for (let i = 0; i < graph.nodes.length; i += 1) {
    const distance = haversineMeters(point, graph.nodes[i]);
    if (distance > SNAP_DISTANCE_METERS) continue;
    matches.push({ index: i, distanceMeters: distance });
  }

  matches.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return matches.slice(0, limit);
}

export function shortestPathDistances(
  graph: WalkGraph,
  start: number,
  maxDistance: number,
): Float64Array {
  return shortestPathDistancesFromSeeds(graph, [{ index: start, distanceMeters: 0 }], maxDistance);
}

export function shortestPathDistancesFromSeeds(
  graph: WalkGraph,
  seeds: NearestNodeMatch[],
  maxDistance: number,
): Float64Array {
  const distances = new Float64Array(graph.nodes.length);
  distances.fill(Number.POSITIVE_INFINITY);

  const queue = new MinPriorityQueue();
  for (const seed of seeds) {
    if (seed.index < 0 || seed.index >= graph.nodes.length) continue;
    if (!Number.isFinite(seed.distanceMeters)) continue;
    if (seed.distanceMeters < 0 || seed.distanceMeters > maxDistance) continue;
    if (seed.distanceMeters >= distances[seed.index]) continue;

    distances[seed.index] = seed.distanceMeters;
    queue.push({ node: seed.index, distance: seed.distanceMeters });
  }

  while (queue.size > 0) {
    const current = queue.pop();
    if (!current) break;

    if (current.distance > maxDistance) break;
    if (current.distance > distances[current.node]) continue;

    for (const neighbor of graph.adjacency[current.node]) {
      const nextDistance = current.distance + neighbor.distance;
      if (nextDistance >= distances[neighbor.to] || nextDistance > maxDistance) continue;
      distances[neighbor.to] = nextDistance;
      queue.push({ node: neighbor.to, distance: nextDistance });
    }
  }

  return distances;
}
