export type LatLng = [number, number];
export type LocalPoint = [number, number];

/** Geographic bounding box in degrees. */
export interface BoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface OverpassNodeElement {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
}

export interface OverpassWayElement {
  type: 'way';
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}

export interface OverpassResponse {
  elements: Array<OverpassNodeElement | OverpassWayElement>;
}

export interface WalkGraph {
  nodes: LatLng[];
  adjacency: WalkGraphEdge[][];
  edgeIndex?: GraphSegmentIndex;
  /** Connected-component id per node index; assigned by buildWalkGraph. */
  componentIdByNode?: Int32Array;
  /** Node count of each connected component, indexed by component id. */
  componentSizes?: number[];
}

export interface WalkGraphEdge {
  toNodeIndex: number;
  distanceMeters: number;
}

export interface GraphSegment {
  fromNodeIndex: number;
  toNodeIndex: number;
  distanceMeters: number;
}

export interface GraphSegmentIndex {
  segments: GraphSegment[];
  buckets: Map<string, number[]>;
  cellSizeDegrees: number;
  lonScale: number;
}

export interface GraphSeed {
  nodeIndex: number;
  initialDistanceMeters: number;
}

export interface EdgeProjectionMatch {
  fromNodeIndex: number;
  toNodeIndex: number;
  snapDistanceMeters: number;
  distanceToFromNodeMeters: number;
  distanceToToNodeMeters: number;
}

export interface WalkshedPolygonAttempt {
  polygon: LatLng[] | null;
  boundaryPointCount: number;
}

export interface ShortestPathsResult {
  distanceByNodeIndex: Float64Array;
  settledNodeIndexes: number[];
}
