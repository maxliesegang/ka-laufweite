import {
  MAX_REASONABLE_STREET_CROSSING_METERS,
  MIN_REASONABLE_STREET_CROSSING_METERS,
  SNAP_DISTANCE_METERS,
} from './constants';
import { haversineMeters } from './geo';
import { MinPriorityQueue } from './priority-queue';
import type {
  LatLng,
  NearestEdgeMatch,
  NearestNodeMatch,
  OverpassResponse,
  WalkGraph,
} from './types';

const ROAD_HIGHWAYS = new Set([
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'unclassified',
  'service',
  'living_street',
]);

interface RoadSegment {
  from: number;
  to: number;
}

function segmentsIntersect(a: LatLng, b: LatLng, c: LatLng, d: LatLng): boolean {
  const orientation = (p: LatLng, q: LatLng, r: LatLng) =>
    (q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1]);
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function isApproximatelyPerpendicular(a: LatLng, b: LatLng, roadA: LatLng, roadB: LatLng): boolean {
  const latitude = (a[0] + b[0]) / 2;
  const lonScale = Math.max(0.2, Math.cos((latitude * Math.PI) / 180));
  const crossingX = (b[1] - a[1]) * lonScale;
  const crossingY = b[0] - a[0];
  const roadX = (roadB[1] - roadA[1]) * lonScale;
  const roadY = roadB[0] - roadA[0];
  const denominator = Math.hypot(crossingX, crossingY) * Math.hypot(roadX, roadY);
  return denominator > 0 && Math.abs((crossingX * roadX + crossingY * roadY) / denominator) <= 0.5;
}

function addReasonableStreetCrossings(
  graph: WalkGraph,
  roadSegments: RoadSegment[],
  roadNodeIndexes: Set<number>,
): void {
  const cellSizeDegrees = MAX_REASONABLE_STREET_CROSSING_METERS / 111_320;
  const lonScale = Math.max(0.2, Math.cos(((graph.nodes[0]?.[0] ?? 0) * Math.PI) / 180));
  const buckets = new Map<string, number[]>();
  const bucketKey = (point: LatLng) =>
    `${Math.floor(point[0] / cellSizeDegrees)}:${Math.floor((point[1] * lonScale) / cellSizeDegrees)}`;
  for (let index = 0; index < graph.nodes.length; index += 1) {
    if (roadNodeIndexes.has(index)) continue;
    const key = bucketKey(graph.nodes[index]);
    const bucket = buckets.get(key) ?? [];
    bucket.push(index);
    buckets.set(key, bucket);
  }

  const added = new Set<string>();
  for (let from = 0; from < graph.nodes.length; from += 1) {
    if (roadNodeIndexes.has(from)) continue;
    const point = graph.nodes[from];
    const latCell = Math.floor(point[0] / cellSizeDegrees);
    const lonCell = Math.floor((point[1] * lonScale) / cellSizeDegrees);
    let best: { to: number; distance: number } | null = null;
    for (let latOffset = -1; latOffset <= 1; latOffset += 1) {
      for (let lonOffset = -1; lonOffset <= 1; lonOffset += 1) {
        for (const to of buckets.get(`${latCell + latOffset}:${lonCell + lonOffset}`) ?? []) {
          if (to <= from) continue;
          const distance = haversineMeters(point, graph.nodes[to]);
          if (
            distance < MIN_REASONABLE_STREET_CROSSING_METERS ||
            distance > MAX_REASONABLE_STREET_CROSSING_METERS ||
            (best && distance >= best.distance)
          )
            continue;
          const crossesRoad = roadSegments.some(({ from: roadFrom, to: roadTo }) => {
            const roadA = graph.nodes[roadFrom];
            const roadB = graph.nodes[roadTo];
            return (
              segmentsIntersect(point, graph.nodes[to], roadA, roadB) &&
              isApproximatelyPerpendicular(point, graph.nodes[to], roadA, roadB)
            );
          });
          if (crossesRoad) best = { to, distance };
        }
      }
    }
    if (!best) continue;
    const key = `${from}:${best.to}`;
    if (added.has(key)) continue;
    added.add(key);
    graph.adjacency[from].push({ to: best.to, distance: best.distance });
    graph.adjacency[best.to].push({ to: from, distance: best.distance });
  }
}

export function buildWalkGraph(
  response: OverpassResponse,
  allowReasonableStreetCrossings = false,
): WalkGraph | null {
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
  const roadSegments: RoadSegment[] = [];
  const roadNodeIndexes = new Set<number>();

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
      if (ROAD_HIGHWAYS.has(way.tags?.highway ?? '')) {
        roadSegments.push({ from, to });
        roadNodeIndexes.add(from);
        roadNodeIndexes.add(to);
      }
    }
  }

  const graph = { nodes, adjacency };
  if (allowReasonableStreetCrossings) {
    addReasonableStreetCrossings(graph, roadSegments, roadNodeIndexes);
  }
  return graph;
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

export function nearestEdgeSeeds(graph: WalkGraph, lat: number, lon: number): NearestNodeMatch[] {
  const origin: LatLng = [lat, lon];
  let nearest: NearestEdgeMatch | null = null;
  const lonScale = Math.max(0.2, Math.cos((lat * Math.PI) / 180));

  for (let from = 0; from < graph.adjacency.length; from += 1) {
    for (const edge of graph.adjacency[from]) {
      if (from >= edge.to) continue;
      const a = graph.nodes[from];
      const b = graph.nodes[edge.to];
      const ax = (a[1] - lon) * lonScale;
      const ay = a[0] - lat;
      const bx = (b[1] - lon) * lonScale;
      const by = b[0] - lat;
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      const t =
        lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
      const projection: LatLng = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const snapDistance = haversineMeters(origin, projection);
      if (
        snapDistance > SNAP_DISTANCE_METERS ||
        (nearest && snapDistance >= nearest.distanceMeters)
      )
        continue;
      nearest = {
        from,
        to: edge.to,
        distanceMeters: snapDistance,
        distanceFromProjectionToFromMeters: edge.distance * t,
        distanceFromProjectionToToMeters: edge.distance * (1 - t),
      };
    }
  }

  if (!nearest) return [];
  return [
    {
      index: nearest.from,
      distanceMeters: nearest.distanceMeters + nearest.distanceFromProjectionToFromMeters,
    },
    {
      index: nearest.to,
      distanceMeters: nearest.distanceMeters + nearest.distanceFromProjectionToToMeters,
    },
  ];
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
