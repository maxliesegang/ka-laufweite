import type { Stop, StopType } from '../types';
import {
  DEFAULT_STOP_RADIUS_METERS_BY_TYPE,
  SHIPPED_STOP_RADII_METERS_BY_TYPE,
  type StopRadiusByType,
} from '../settings';
import {
  decodeWalkshedPolygon,
  parseWalkshedDataset,
  shippedWalkshedDataPath,
  walkshedDatasetPolygonKey,
  type WalkshedDataset,
} from './walkshed-codec';
import type { LatLng } from './types';

function datasetUrl(type: StopType, radiusMeters: number): string {
  return `${import.meta.env.BASE_URL}${shippedWalkshedDataPath(type, radiusMeters)}`;
}

const datasetPromises = new Map<string, Promise<WalkshedDataset | null>>();
const decodedPolygons = new Map<string, LatLng[]>();

function datasetKey(type: StopType, radiusMeters: number): string {
  return `${type}:${radiusMeters}`;
}

function loadDataset(type: StopType, radiusMeters: number): Promise<WalkshedDataset | null> {
  const key = datasetKey(type, radiusMeters);
  let promise = datasetPromises.get(key);
  if (!promise) {
    promise = fetch(datasetUrl(type, radiusMeters), { cache: 'default' })
      .then(async (response) => {
        if (!response.ok) return null;
        const payload: unknown = await response.json();
        return parseWalkshedDataset(payload);
      })
      // A missing/broken shipped dataset must never break the runtime path: the
      // service simply falls back to computing polygons from Overpass as before.
      .catch(() => null);
    datasetPromises.set(key, promise);
  }
  return promise;
}

/**
 * Warm the shipped datasets for the given stop types and configured radii — the
 * ones visible on load — so the first polygon lookup doesn't wait on a cold fetch.
 * Hidden types (e.g. bus by default) are fetched lazily on their first
 * {@link loadShippedWalkshedPolygon}. Returns true only if every requested
 * type/radius dataset loaded successfully.
 */
export async function preloadShippedWalksheds(
  types: Iterable<StopType>,
  radiusByType: StopRadiusByType = DEFAULT_STOP_RADIUS_METERS_BY_TYPE,
): Promise<boolean> {
  const datasets = await Promise.all(
    [...types].map((type) => loadDataset(type, radiusByType[type])),
  );
  return datasets.length > 0 && datasets.every((dataset) => dataset !== null);
}

/**
 * Return a precomputed polygon shipped with the app, or null if the request
 * doesn't match a baked configuration (custom stop, unsupported
 * radius, crossings toggled off) or no polygon was baked for this stop.
 *
 * Loads only the dataset for the stop's type and radius, and is network-free
 * after that one-time fetch. The service checks it after browser persistence
 * and before scheduling an Overpass calculation.
 */
export async function loadShippedWalkshedPolygon(
  stop: Stop,
  radiusMeters: number,
  allowReasonableStreetCrossings: boolean,
): Promise<LatLng[] | null> {
  if (stop.isCustom) return null;
  if (!SHIPPED_STOP_RADII_METERS_BY_TYPE[stop.type].includes(radiusMeters)) return null;

  const dataset = await loadDataset(stop.type, radiusMeters);
  if (!dataset) return null;
  if (dataset.allowReasonableStreetCrossings !== allowReasonableStreetCrossings) return null;
  if (dataset.radiusByType[stop.type] !== radiusMeters) return null;

  const polygonKey = walkshedDatasetPolygonKey(stop);
  const encoded = dataset.polygons[polygonKey];
  if (!encoded) return null;

  const decodedCacheKey = `${polygonKey}:${radiusMeters}`;
  const cached = decodedPolygons.get(decodedCacheKey);
  if (cached) return cached;

  const polygon = decodeWalkshedPolygon(encoded, dataset.precision);
  decodedPolygons.set(decodedCacheKey, polygon);
  return polygon;
}
