import { findNearestEdgeSeeds } from './graph';
import { buildWalkshedPolygonFromSeeds } from './polygon';
import type { LatLng, WalkGraph } from './types';

export interface WalkshedCalculationRequest {
  stopId: string;
  lat: number;
  lon: number;
  radiusMeters: number;
}

export type WalkshedCalculationResult =
  | { stopId: string; status: 'polygon'; polygon: LatLng[] }
  | {
      stopId: string;
      status: 'unavailable';
      reason: 'no-nearby-edge' | 'invalid-polygon';
    };

export function calculateWalkshedPolygons(
  graph: WalkGraph,
  requests: readonly WalkshedCalculationRequest[],
): WalkshedCalculationResult[] {
  return requests.map((request): WalkshedCalculationResult => {
    try {
      const seeds = findNearestEdgeSeeds(graph, request.lat, request.lon);
      if (seeds.length === 0) {
        return { stopId: request.stopId, status: 'unavailable', reason: 'no-nearby-edge' };
      }

      const polygon = buildWalkshedPolygonFromSeeds(
        graph,
        request.lat,
        request.lon,
        request.radiusMeters,
        seeds,
      ).polygon;
      if (polygon) return { stopId: request.stopId, status: 'polygon', polygon };
    } catch (error) {
      console.error(`Walkshed calculation failed for ${request.stopId}:`, error);
    }

    return { stopId: request.stopId, status: 'unavailable', reason: 'invalid-polygon' };
  });
}
