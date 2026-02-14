export type LatLng = [number, number];
export type LocalPoint = [number, number];

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
}

export interface OverpassResponse {
  elements: Array<OverpassNodeElement | OverpassWayElement>;
}

export interface WalkGraph {
  nodes: LatLng[];
  adjacency: Array<Array<{ to: number; distance: number }>>;
}

export interface NearestNodeMatch {
  index: number;
  distanceMeters: number;
}

export interface WalkshedAttempt {
  polygon: LatLng[] | null;
  boundaryPointCount: number;
}
