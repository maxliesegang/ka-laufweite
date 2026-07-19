import { STOP_TYPES, isStopType, mapStopTypes, type Stop, type StopType } from '../types';
import type { LatLng } from './types';

/** Bump when the on-disk format changes incompatibly; the runtime then ignores
 *  older files and falls back to live Overpass computation until they're rebuilt. */
export const WALKSHED_DATA_VERSION = 1;

/** 1e5 ≈ 1.1 m resolution — far finer than a concave-hull walkshed's accuracy. */
export const WALKSHED_DATA_PRECISION = 100_000;

/**
 * Shipped precomputed-walkshed format, shared by the offline build script
 * (encoder) and the runtime loader (decoder) so the two never drift.
 *
 * Polygons are stored per stop snapshot key as a flat integer array:
 *   [lat0, lon0, dlat1, dlon1, dlat2, dlon2, ...]
 * where the first pair is the absolute coordinate scaled by `precision` and the
 * rest are deltas from the previous point. The representation is compact and
 * compresses well while remaining inexpensive to decode in the browser.
 */
export interface WalkshedDataset {
  version: typeof WALKSHED_DATA_VERSION;
  generatedAt: string;
  precision: number;
  /** Configuration the polygons were baked with; a request only hits shipped
   *  data when it matches these exactly. */
  allowReasonableStreetCrossings: boolean;
  radiusByType: Record<StopType, number>;
  /** stop snapshot key -> delta-encoded integer coordinate stream */
  polygons: Record<string, number[]>;
}

/**
 * Bind shipped polygons to the stop snapshot that produced them. Stop ids can
 * survive OSM coordinate or type changes, so an id alone is not sufficient.
 */
export function walkshedDatasetPolygonKey(stop: Pick<Stop, 'id' | 'lat' | 'lon' | 'type'>): string {
  return `${stop.id}:${stop.type}:${stop.lat}:${stop.lon}`;
}

/** Basename of the shipped dataset for one stop type and radius, so the map
 *  only downloads the exact polygon set it currently needs. */
export function shippedWalkshedDataFilename(type: StopType, radiusMeters: number): string {
  return `walksheds-${type}-${radiusMeters}.json`;
}

/** Public path (relative to BASE_URL) of one shipped type/radius dataset. */
export function shippedWalkshedDataPath(type: StopType, radiusMeters: number): string {
  return `data/${shippedWalkshedDataFilename(type, radiusMeters)}`;
}

/**
 * Read the stop type baked into a polygon key (`id:type:lat:lon`). The id may
 * itself contain colons, so the type is located by offset from the end rather
 * than by field index. Returns null for malformed keys.
 */
function stopTypeFromPolygonKey(key: string): StopType | null {
  const parts = key.split(':');
  const type = parts[parts.length - 3];
  return type !== undefined && isStopType(type) ? type : null;
}

/**
 * Partition a combined dataset into one dataset per stop type, copying the shared
 * metadata unchanged. Used by the build step to emit per-type files.
 */
export function partitionWalkshedDatasetByType(
  dataset: WalkshedDataset,
): Record<StopType, WalkshedDataset> {
  const polygonsByType = mapStopTypes<Record<string, number[]>>(() => ({}));
  for (const [key, polygon] of Object.entries(dataset.polygons)) {
    const type = stopTypeFromPolygonKey(key);
    if (type) polygonsByType[type][key] = polygon;
  }
  return mapStopTypes((type) => ({ ...dataset, polygons: polygonsByType[type] }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isEncodedPolygon(value: unknown, precision: number): value is number[] {
  if (!Array.isArray(value) || value.length < 6 || value.length % 2 !== 0) return false;

  let latitude = 0;
  let longitude = 0;
  for (let index = 0; index < value.length; index += 2) {
    const latitudeDelta = value[index];
    const longitudeDelta = value[index + 1];
    if (!Number.isSafeInteger(latitudeDelta) || !Number.isSafeInteger(longitudeDelta)) return false;

    latitude += latitudeDelta;
    longitude += longitudeDelta;
    if (
      !Number.isSafeInteger(latitude) ||
      !Number.isSafeInteger(longitude) ||
      Math.abs(latitude / precision) > 90 ||
      Math.abs(longitude / precision) > 180
    ) {
      return false;
    }
  }

  return true;
}

/** Validate the complete external JSON payload before exposing typed data. */
export function parseWalkshedDataset(value: unknown): WalkshedDataset | null {
  if (!isRecord(value)) return null;
  if (value.version !== WALKSHED_DATA_VERSION) return null;
  if (typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))) {
    return null;
  }
  const precision = value.precision;
  if (!Number.isSafeInteger(precision) || !isPositiveFiniteNumber(precision)) return null;
  if (typeof value.allowReasonableStreetCrossings !== 'boolean') return null;
  if (!isRecord(value.radiusByType) || !isRecord(value.polygons)) return null;
  const radiusByType = value.radiusByType;
  const polygons = value.polygons;
  if (!STOP_TYPES.every((stopType) => isPositiveFiniteNumber(radiusByType[stopType]))) {
    return null;
  }
  if (!Object.values(polygons).every((polygon) => isEncodedPolygon(polygon, precision))) {
    return null;
  }

  return value as unknown as WalkshedDataset;
}

export function encodeWalkshedPolygon(
  polygon: LatLng[],
  precision: number = WALKSHED_DATA_PRECISION,
): number[] {
  const encoded: number[] = [];
  let prevLat = 0;
  let prevLon = 0;
  for (const [lat, lon] of polygon) {
    const qLat = Math.round(lat * precision);
    const qLon = Math.round(lon * precision);
    encoded.push(qLat - prevLat, qLon - prevLon);
    prevLat = qLat;
    prevLon = qLon;
  }
  return encoded;
}

export function decodeWalkshedPolygon(
  encoded: number[],
  precision: number = WALKSHED_DATA_PRECISION,
): LatLng[] {
  const polygon: LatLng[] = [];
  let lat = 0;
  let lon = 0;
  for (let i = 0; i + 1 < encoded.length; i += 2) {
    lat += encoded[i];
    lon += encoded[i + 1];
    polygon.push([lat / precision, lon / precision]);
  }
  return polygon;
}
