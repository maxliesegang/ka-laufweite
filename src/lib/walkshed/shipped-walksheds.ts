import type { Stop, StopType } from '../types';
import {
  decodeWalkshedPolygon,
  parseWalkshedDataset,
  shippedWalkshedDataPath,
  walkshedDatasetPolygonKey,
  type WalkshedDataset,
} from './walkshed-codec';
import type { LatLng } from './types';

function datasetUrl(type: StopType): string {
  return `${import.meta.env.BASE_URL}${shippedWalkshedDataPath(type)}`;
}

const datasetPromiseByType = new Map<StopType, Promise<WalkshedDataset | null>>();
const decodedPolygons = new Map<string, LatLng[]>();

function loadDataset(type: StopType): Promise<WalkshedDataset | null> {
  let promise = datasetPromiseByType.get(type);
  if (!promise) {
    promise = fetch(datasetUrl(type), { cache: 'default' })
      .then(async (response) => {
        if (!response.ok) return null;
        const payload: unknown = await response.json();
        return parseWalkshedDataset(payload);
      })
      // A missing/broken shipped dataset must never break the runtime path: the
      // service simply falls back to computing polygons from Overpass as before.
      .catch(() => null);
    datasetPromiseByType.set(type, promise);
  }
  return promise;
}

/**
 * Warm the shipped datasets for the given stop types — the ones visible on load —
 * so the first polygon lookup doesn't wait on a cold fetch. Hidden types (e.g. bus
 * by default) are fetched lazily on their first {@link loadShippedWalkshedPolygon}.
 * Returns true only if every requested type loaded successfully.
 */
export async function preloadShippedWalksheds(types: Iterable<StopType>): Promise<boolean> {
  const datasets = await Promise.all([...types].map((type) => loadDataset(type)));
  return datasets.length > 0 && datasets.every((dataset) => dataset !== null);
}

/**
 * Return a precomputed polygon shipped with the app, or null if the request
 * doesn't match the baked default configuration (custom stop, non-default
 * radius, crossings toggled off) or no polygon was baked for this stop.
 *
 * Loads only the dataset for the stop's type, and is network-free after that
 * one-time fetch. The service checks it after browser persistence and before
 * scheduling an Overpass calculation.
 */
export async function loadShippedWalkshedPolygon(
  stop: Stop,
  radiusMeters: number,
  allowReasonableStreetCrossings: boolean,
): Promise<LatLng[] | null> {
  if (stop.isCustom) return null;

  const dataset = await loadDataset(stop.type);
  if (!dataset) return null;
  if (dataset.allowReasonableStreetCrossings !== allowReasonableStreetCrossings) return null;
  if (dataset.radiusByType[stop.type] !== radiusMeters) return null;

  const polygonKey = walkshedDatasetPolygonKey(stop);
  const encoded = dataset.polygons[polygonKey];
  if (!encoded) return null;

  const cached = decodedPolygons.get(polygonKey);
  if (cached) return cached;

  const polygon = decodeWalkshedPolygon(encoded, dataset.precision);
  decodedPolygons.set(polygonKey, polygon);
  return polygon;
}
