import {
  COMPONENT_BRIDGE_DISTANCE_METERS,
  MAX_REASONABLE_STREET_CROSSING_METERS,
  MIN_REASONABLE_STREET_CROSSING_METERS,
  MIN_SUBSTANTIAL_COMPONENT_NODES,
  SNAP_DISTANCE_METERS,
  SUBSTANTIAL_COMPONENT_FRACTION,
} from './constants';
import { haversineMeters } from './geo';
import { MinDistanceQueue } from './priority-queue';
import type {
  LatLng,
  GraphSegment,
  EdgeProjectionMatch,
  GraphSeed,
  OverpassResponse,
  GraphSegmentIndex,
  ShortestPathsResult,
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

function spatialCellKey(latCell: number, lonCell: number): string {
  return `${latCell}:${lonCell}`;
}

function buildGraphSegmentIndex(
  graph: WalkGraph,
  segments: GraphSegment[],
  cellSizeMeters: number,
): GraphSegmentIndex {
  const cellSizeDegrees = cellSizeMeters / 111_320;
  const lonScale = Math.max(0.2, Math.cos(((graph.nodes[0]?.[0] ?? 0) * Math.PI) / 180));
  const buckets = new Map<string, number[]>();

  segments.forEach((segment, segmentIndex) => {
    const from = graph.nodes[segment.fromNodeIndex];
    const to = graph.nodes[segment.toNodeIndex];
    const southCell = Math.floor(Math.min(from[0], to[0]) / cellSizeDegrees);
    const northCell = Math.floor(Math.max(from[0], to[0]) / cellSizeDegrees);
    const westCell = Math.floor((Math.min(from[1], to[1]) * lonScale) / cellSizeDegrees);
    const eastCell = Math.floor((Math.max(from[1], to[1]) * lonScale) / cellSizeDegrees);

    for (let latCell = southCell; latCell <= northCell; latCell += 1) {
      for (let lonCell = westCell; lonCell <= eastCell; lonCell += 1) {
        const key = spatialCellKey(latCell, lonCell);
        const bucket = buckets.get(key) ?? [];
        bucket.push(segmentIndex);
        buckets.set(key, bucket);
      }
    }
  });

  return { segments, buckets, cellSizeDegrees, lonScale };
}

function findSegmentIndexesNearLine(
  index: GraphSegmentIndex,
  a: LatLng,
  b: LatLng,
  paddingMeters = 0,
): number[] {
  const paddingDegrees = paddingMeters / 111_320;
  const southCell = Math.floor((Math.min(a[0], b[0]) - paddingDegrees) / index.cellSizeDegrees);
  const northCell = Math.floor((Math.max(a[0], b[0]) + paddingDegrees) / index.cellSizeDegrees);
  const westCell = Math.floor(
    (Math.min(a[1], b[1]) * index.lonScale - paddingDegrees) / index.cellSizeDegrees,
  );
  const eastCell = Math.floor(
    (Math.max(a[1], b[1]) * index.lonScale + paddingDegrees) / index.cellSizeDegrees,
  );
  const matches = new Set<number>();
  for (let latCell = southCell; latCell <= northCell; latCell += 1) {
    for (let lonCell = westCell; lonCell <= eastCell; lonCell += 1) {
      for (const segmentIndex of index.buckets.get(spatialCellKey(latCell, lonCell)) ?? []) {
        matches.add(segmentIndex);
      }
    }
  }
  return [...matches];
}

function graphSegments(graph: WalkGraph): GraphSegment[] {
  const segments: GraphSegment[] = [];
  for (let fromNodeIndex = 0; fromNodeIndex < graph.adjacency.length; fromNodeIndex += 1) {
    for (const edge of graph.adjacency[fromNodeIndex]) {
      if (fromNodeIndex < edge.toNodeIndex) {
        segments.push({
          fromNodeIndex,
          toNodeIndex: edge.toNodeIndex,
          distanceMeters: edge.distanceMeters,
        });
      }
    }
  }
  return segments;
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
  roadSegments: GraphSegment[],
  roadNodeIndexes: Set<number>,
): void {
  const cellSizeDegrees = MAX_REASONABLE_STREET_CROSSING_METERS / 111_320;
  const lonScale = Math.max(0.2, Math.cos(((graph.nodes[0]?.[0] ?? 0) * Math.PI) / 180));
  const nodeIndexesByCellKey = new Map<string, number[]>();
  const cellKey = (point: LatLng) =>
    spatialCellKey(
      Math.floor(point[0] / cellSizeDegrees),
      Math.floor((point[1] * lonScale) / cellSizeDegrees),
    );
  for (let nodeIndex = 0; nodeIndex < graph.nodes.length; nodeIndex += 1) {
    if (roadNodeIndexes.has(nodeIndex)) continue;
    const key = cellKey(graph.nodes[nodeIndex]);
    const cellNodeIndexes = nodeIndexesByCellKey.get(key) ?? [];
    cellNodeIndexes.push(nodeIndex);
    nodeIndexesByCellKey.set(key, cellNodeIndexes);
  }

  const roadIndex = buildGraphSegmentIndex(
    graph,
    roadSegments,
    MAX_REASONABLE_STREET_CROSSING_METERS,
  );
  for (let fromNodeIndex = 0; fromNodeIndex < graph.nodes.length; fromNodeIndex += 1) {
    if (roadNodeIndexes.has(fromNodeIndex)) continue;
    const fromPoint = graph.nodes[fromNodeIndex];
    const latCell = Math.floor(fromPoint[0] / cellSizeDegrees);
    const lonCell = Math.floor((fromPoint[1] * lonScale) / cellSizeDegrees);
    let bestCrossing: { toNodeIndex: number; distanceMeters: number } | null = null;
    for (let latOffset = -1; latOffset <= 1; latOffset += 1) {
      for (let lonOffset = -1; lonOffset <= 1; lonOffset += 1) {
        const cellNodeIndexes =
          nodeIndexesByCellKey.get(spatialCellKey(latCell + latOffset, lonCell + lonOffset)) ?? [];
        for (const toNodeIndex of cellNodeIndexes) {
          if (toNodeIndex <= fromNodeIndex) continue;
          const toPoint = graph.nodes[toNodeIndex];
          const distanceMeters = haversineMeters(fromPoint, toPoint);
          if (
            distanceMeters < MIN_REASONABLE_STREET_CROSSING_METERS ||
            distanceMeters > MAX_REASONABLE_STREET_CROSSING_METERS ||
            (bestCrossing && distanceMeters >= bestCrossing.distanceMeters)
          )
            continue;
          const crossesRoad = findSegmentIndexesNearLine(roadIndex, fromPoint, toPoint).some(
            (roadSegmentIndex) => {
              const { fromNodeIndex: roadFromNodeIndex, toNodeIndex: roadToNodeIndex } =
                roadSegments[roadSegmentIndex];
              const roadFromPoint = graph.nodes[roadFromNodeIndex];
              const roadToPoint = graph.nodes[roadToNodeIndex];
              return (
                segmentsIntersect(fromPoint, toPoint, roadFromPoint, roadToPoint) &&
                isApproximatelyPerpendicular(fromPoint, toPoint, roadFromPoint, roadToPoint)
              );
            },
          );
          if (crossesRoad) bestCrossing = { toNodeIndex, distanceMeters };
        }
      }
    }
    if (!bestCrossing) continue;
    // A crossing may re-propose a pair the ways already connect. Way edges are
    // deduplicated at build time, and a parallel edge can never shorten a route,
    // so it would only duplicate work in Dijkstra and in boundary extraction.
    const { toNodeIndex, distanceMeters } = bestCrossing;
    if (graph.adjacency[fromNodeIndex].some((edge) => edge.toNodeIndex === toNodeIndex)) continue;
    graph.adjacency[fromNodeIndex].push({ toNodeIndex, distanceMeters });
    graph.adjacency[toNodeIndex].push({ toNodeIndex: fromNodeIndex, distanceMeters });
  }
}

export function buildWalkGraph(
  networkData: OverpassResponse,
  allowReasonableStreetCrossings = false,
): WalkGraph | null {
  const nodeById = new Map<number, LatLng>();
  const wayNodeIds = new Set<number>();
  const ways = networkData.elements.filter((element) => element.type === 'way');

  for (const element of networkData.elements) {
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

  const adjacency = nodes.map(() => [] as WalkGraph['adjacency'][number]);
  const dedupEdges = new Set<string>();
  const roadSegments: GraphSegment[] = [];
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

      const distanceMeters = haversineMeters(nodes[from], nodes[to]);
      if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) continue;

      adjacency[from].push({ toNodeIndex: to, distanceMeters });
      adjacency[to].push({ toNodeIndex: from, distanceMeters });
      if (ROAD_HIGHWAYS.has(way.tags?.highway ?? '')) {
        roadSegments.push({
          fromNodeIndex: from,
          toNodeIndex: to,
          distanceMeters,
        });
        roadNodeIndexes.add(from);
        roadNodeIndexes.add(to);
      }
    }
  }

  const graph: WalkGraph = { nodes, adjacency };
  if (allowReasonableStreetCrossings) {
    addReasonableStreetCrossings(graph, roadSegments, roadNodeIndexes);
  }
  graph.edgeIndex = buildGraphSegmentIndex(graph, graphSegments(graph), SNAP_DISTANCE_METERS);
  // Components are assigned after crossings, whose extra edges merge stubs into
  // the network, so seed snapping bridges only genuinely isolated components.
  assignConnectedComponents(graph);
  return graph;
}

/** Label every node with its connected-component id and record component sizes. */
function assignConnectedComponents(graph: WalkGraph): void {
  const componentIdByNode = new Int32Array(graph.nodes.length).fill(-1);
  const componentSizes: number[] = [];

  for (let start = 0; start < graph.nodes.length; start += 1) {
    if (componentIdByNode[start] !== -1) continue;

    const componentId = componentSizes.length;
    const stack = [start];
    componentIdByNode[start] = componentId;
    let size = 0;

    while (stack.length > 0) {
      const nodeIndex = stack.pop();
      if (nodeIndex === undefined) break;
      size += 1;
      for (const edge of graph.adjacency[nodeIndex]) {
        if (componentIdByNode[edge.toNodeIndex] === -1) {
          componentIdByNode[edge.toNodeIndex] = componentId;
          stack.push(edge.toNodeIndex);
        }
      }
    }

    componentSizes.push(size);
  }

  graph.componentIdByNode = componentIdByNode;
  graph.componentSizes = componentSizes;
}

/** Smallest component that is worth bridging a disconnected stub to. */
function substantialComponentThreshold(componentSizes: number[]): number {
  const largest = componentSizes.reduce((max, size) => Math.max(max, size), 0);
  return Math.max(
    MIN_SUBSTANTIAL_COMPONENT_NODES,
    Math.floor(SUBSTANTIAL_COMPONENT_FRACTION * largest),
  );
}

export function findNearestNodeSeeds(
  graph: WalkGraph,
  lat: number,
  lon: number,
  limit: number,
): GraphSeed[] {
  const point: LatLng = [lat, lon];
  const matches: GraphSeed[] = [];

  for (let i = 0; i < graph.nodes.length; i += 1) {
    const distanceMeters = haversineMeters(point, graph.nodes[i]);
    if (distanceMeters > SNAP_DISTANCE_METERS) continue;
    matches.push({ nodeIndex: i, initialDistanceMeters: distanceMeters });
  }

  matches.sort((a, b) => a.initialDistanceMeters - b.initialDistanceMeters);
  return matches.slice(0, limit);
}

function comparePoints(a: LatLng, b: LatLng): number {
  return a[0] - b[0] || a[1] - b[1];
}

/**
 * Order two segments by geometry alone. Node indexes reflect the order ways
 * arrived from Overpass, so they cannot break a tie reproducibly; the endpoint
 * coordinates are a property of the network itself.
 *
 * Segments that are geometrically identical compare equal — nothing here can
 * separate them, and their projections are interchangeable anyway.
 */
function compareSegmentsByGeometry(
  graph: WalkGraph,
  a: { fromNodeIndex: number; toNodeIndex: number },
  b: { fromNodeIndex: number; toNodeIndex: number },
): number {
  const orderedEndpoints = ({ fromNodeIndex, toNodeIndex }: typeof a): [LatLng, LatLng] => {
    const from = graph.nodes[fromNodeIndex];
    const to = graph.nodes[toNodeIndex];
    return comparePoints(from, to) <= 0 ? [from, to] : [to, from];
  };
  const [aFirst, aSecond] = orderedEndpoints(a);
  const [bFirst, bSecond] = orderedEndpoints(b);
  return comparePoints(aFirst, bFirst) || comparePoints(aSecond, bSecond);
}

/**
 * Project the stop onto the nearest edge within `maxSnapDistanceMeters`. When
 * `isAllowedNode` is given, only edges whose endpoints satisfy it are eligible,
 * which lets callers restrict snapping to substantial components.
 */
function projectNearestEdge(
  graph: WalkGraph,
  lat: number,
  lon: number,
  maxSnapDistanceMeters: number,
  isAllowedNode?: (nodeIndex: number) => boolean,
): EdgeProjectionMatch | null {
  const origin: LatLng = [lat, lon];
  let nearest: EdgeProjectionMatch | null = null;
  const lonScale = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const indexedSegments = graph.edgeIndex;
  const segments = indexedSegments
    ? findSegmentIndexesNearLine(indexedSegments, origin, origin, maxSnapDistanceMeters).map(
        (segmentIndex) => indexedSegments.segments[segmentIndex],
      )
    : graphSegments(graph);

  for (const { fromNodeIndex: from, toNodeIndex: to, distanceMeters } of segments) {
    if (isAllowedNode && !isAllowedNode(from)) continue;
    const a = graph.nodes[from];
    const b = graph.nodes[to];
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
    if (snapDistance > maxSnapDistanceMeters) continue;
    if (nearest) {
      if (snapDistance > nearest.snapDistanceMeters) continue;
      // A stop equidistant from two edges — mirrored geometry, a platform mapped
      // from both sides — would otherwise snap to whichever the index yielded
      // first, and pick a different walkshed when the ways arrive in another order.
      const candidate = { fromNodeIndex: from, toNodeIndex: to };
      if (
        snapDistance === nearest.snapDistanceMeters &&
        compareSegmentsByGeometry(graph, candidate, nearest) >= 0
      ) {
        continue;
      }
    }
    nearest = {
      fromNodeIndex: from,
      toNodeIndex: to,
      snapDistanceMeters: snapDistance,
      distanceToFromNodeMeters: distanceMeters * t,
      distanceToToNodeMeters: distanceMeters * (1 - t),
    };
  }

  return nearest;
}

function seedsFromEdgeProjection(match: EdgeProjectionMatch): GraphSeed[] {
  return [
    {
      nodeIndex: match.fromNodeIndex,
      initialDistanceMeters: match.snapDistanceMeters + match.distanceToFromNodeMeters,
    },
    {
      nodeIndex: match.toNodeIndex,
      initialDistanceMeters: match.snapDistanceMeters + match.distanceToToNodeMeters,
    },
  ];
}

/**
 * Snap the stop onto the walk graph. Normally this is just the nearest edge, but
 * when that edge sits on a tiny disconnected stub (a common rail/tram-platform
 * artifact) the walkshed would collapse onto the stub, so the stop additionally
 * snaps to the nearest substantial component within COMPONENT_BRIDGE_DISTANCE_METERS.
 * The stub seeds are kept too — that is where the rider stands and it is contiguous.
 */
export function findNearestEdgeSeeds(graph: WalkGraph, lat: number, lon: number): GraphSeed[] {
  const nearest = projectNearestEdge(graph, lat, lon, SNAP_DISTANCE_METERS);
  if (!nearest) return [];
  const seeds = seedsFromEdgeProjection(nearest);

  const { componentIdByNode, componentSizes } = graph;
  if (!componentIdByNode || !componentSizes) return seeds;

  const threshold = substantialComponentThreshold(componentSizes);
  const nearestComponentSize = componentSizes[componentIdByNode[nearest.fromNodeIndex]] ?? 0;
  if (nearestComponentSize >= threshold) return seeds;

  const bridge = projectNearestEdge(
    graph,
    lat,
    lon,
    COMPONENT_BRIDGE_DISTANCE_METERS,
    (nodeIndex) => (componentSizes[componentIdByNode[nodeIndex]] ?? 0) >= threshold,
  );
  if (bridge) seeds.push(...seedsFromEdgeProjection(bridge));

  return seeds;
}

export function calculateShortestPathDistances(
  graph: WalkGraph,
  seeds: GraphSeed[],
  maxDistanceMeters: number,
): Float64Array {
  return calculateShortestPaths(graph, seeds, maxDistanceMeters).distanceByNodeIndex;
}

export function calculateShortestPaths(
  graph: WalkGraph,
  seeds: GraphSeed[],
  maxDistanceMeters: number,
): ShortestPathsResult {
  const distanceByNodeIndex = new Float64Array(graph.nodes.length);
  distanceByNodeIndex.fill(Number.POSITIVE_INFINITY);
  const settledNodeIndexes: number[] = [];

  const queue = new MinDistanceQueue();
  for (const seed of seeds) {
    if (seed.nodeIndex < 0 || seed.nodeIndex >= graph.nodes.length) continue;
    if (!Number.isFinite(seed.initialDistanceMeters)) continue;
    if (seed.initialDistanceMeters < 0 || seed.initialDistanceMeters > maxDistanceMeters) continue;
    if (seed.initialDistanceMeters >= distanceByNodeIndex[seed.nodeIndex]) continue;

    distanceByNodeIndex[seed.nodeIndex] = seed.initialDistanceMeters;
    queue.push({ nodeIndex: seed.nodeIndex, distanceMeters: seed.initialDistanceMeters });
  }

  while (queue.size > 0) {
    const current = queue.pop();
    if (!current) break;

    if (current.distanceMeters > maxDistanceMeters) break;
    if (current.distanceMeters > distanceByNodeIndex[current.nodeIndex]) continue;
    settledNodeIndexes.push(current.nodeIndex);

    for (const neighbor of graph.adjacency[current.nodeIndex]) {
      const nextDistance = current.distanceMeters + neighbor.distanceMeters;
      if (
        nextDistance >= distanceByNodeIndex[neighbor.toNodeIndex] ||
        nextDistance > maxDistanceMeters
      )
        continue;
      distanceByNodeIndex[neighbor.toNodeIndex] = nextDistance;
      queue.push({ nodeIndex: neighbor.toNodeIndex, distanceMeters: nextDistance });
    }
  }

  return { distanceByNodeIndex, settledNodeIndexes };
}
