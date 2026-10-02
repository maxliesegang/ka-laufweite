/**
 * One footway network query, one walk graph, many stops: nearby stops share a
 * padded query area, and every radius of a stop is polygonised from that graph.
 */
import { DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS } from '../../src/lib/settings.ts';
import type { Stop } from '../../src/lib/types.ts';
import { buildWalkGraph, findNearestEdgeSeeds } from '../../src/lib/walkshed/graph.ts';
import { buildWalkshedPolygonsFromSeeds } from '../../src/lib/walkshed/polygon.ts';
import { createWalkshedQueryArea } from '../../src/lib/walkshed/query-area.ts';
import {
  encodeWalkshedPolygon,
  walkshedDatasetPolygonKey,
} from '../../src/lib/walkshed/walkshed-codec.ts';
import type { LocalFootwayNetwork } from './local-footway-network.ts';
import type { RadiiMetersByStopType } from './options.ts';

const MAX_STOPS_PER_BATCH = 48;
const BATCH_LATITUDE_DEGREES = 0.01;
const BATCH_LONGITUDE_DEGREES = 0.015;

/** What one stop yielded across the radii it was built for. */
export interface StopPolygonResult {
  encodedPolygonsByRadiusMeters: Map<number, number[]>;
  /** Radius variants with no reachable footways — legitimately empty, not failures. */
  emptyRadiusCount: number;
}

/** Group stops into small geographic cells. The shared query is padded by the
 * radius bucket and safety margin, preserving the runtime no-truncation invariant. */
export function createStopBatches(stops: Stop[]): Stop[][] {
  const stopsByCellKey = new Map<string, Stop[]>();
  for (const stop of stops) {
    const cellKey = `${Math.floor(stop.lat / BATCH_LATITUDE_DEGREES)}:${Math.floor(stop.lon / BATCH_LONGITUDE_DEGREES)}`;
    const cellStops = stopsByCellKey.get(cellKey);
    if (cellStops) cellStops.push(stop);
    else stopsByCellKey.set(cellKey, [stop]);
  }

  const batches: Stop[][] = [];
  for (const cellStops of stopsByCellKey.values()) {
    for (let start = 0; start < cellStops.length; start += MAX_STOPS_PER_BATCH) {
      batches.push(cellStops.slice(start, start + MAX_STOPS_PER_BATCH));
    }
  }
  return batches;
}

/** Build every requested radius of every stop in one batch from a single
 *  footway network query. */
export function computeStopBatch(
  stops: Stop[],
  radiiByStopType: RadiiMetersByStopType,
  footwayNetwork: LocalFootwayNetwork,
): Map<string, StopPolygonResult> {
  const queryArea = createWalkshedQueryArea(
    stops.map((stop) => ({
      lat: stop.lat,
      lon: stop.lon,
      radiusMeters: Math.max(...radiiByStopType[stop.type]),
    })),
  );
  if (!queryArea) return new Map();

  const networkData = footwayNetwork.footwayNetworkInBounds(queryArea.bounds);
  const graph = buildWalkGraph(networkData, DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS);
  const polygonResultsByPolygonKey = new Map<string, StopPolygonResult>();
  if (!graph) {
    for (const stop of stops) {
      polygonResultsByPolygonKey.set(walkshedDatasetPolygonKey(stop), {
        // Distinct radii only: a repeated radius yields a single output variant.
        emptyRadiusCount: new Set(radiiByStopType[stop.type]).size,
        encodedPolygonsByRadiusMeters: new Map(),
      });
    }
    return polygonResultsByPolygonKey;
  }

  for (const stop of stops) {
    const seeds = findNearestEdgeSeeds(graph, stop.lat, stop.lon);
    const attemptsByRadiusMeters = buildWalkshedPolygonsFromSeeds(
      graph,
      stop.lat,
      stop.lon,
      radiiByStopType[stop.type],
      seeds,
    );
    const encodedPolygonsByRadiusMeters = new Map<number, number[]>();
    for (const [radiusMeters, attempt] of attemptsByRadiusMeters) {
      if (attempt.polygon) {
        encodedPolygonsByRadiusMeters.set(radiusMeters, encodeWalkshedPolygon(attempt.polygon));
      }
    }
    polygonResultsByPolygonKey.set(walkshedDatasetPolygonKey(stop), {
      encodedPolygonsByRadiusMeters,
      // One attempt per distinct radius, so this stays correct if the radii repeat one.
      emptyRadiusCount: attemptsByRadiusMeters.size - encodedPolygonsByRadiusMeters.size,
    });
  }

  return polygonResultsByPolygonKey;
}
