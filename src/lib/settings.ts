import { getStorageItem, readStorageJson, setStorageItem, writeStorageJson } from './storage';
import { STOP_TYPE_CONFIG } from './stop-type-config';
import { STOP_TYPES, mapStopTypes, type StopType } from './types';

export const LEGACY_STOP_RADIUS_STORAGE_KEY = 'karlsruhe-opnv-stop-radius-meters';
export const STOP_RADIUS_STORAGE_KEYS: Record<StopType, string> = mapStopTypes(
  (stopType) => `karlsruhe-opnv-stop-radius-meters-${stopType}`,
);
export const STOP_RADIUS_INPUT_IDS: Record<StopType, string> = mapStopTypes(
  (stopType) => STOP_TYPE_CONFIG[stopType].radiusInputId,
);

const DEFAULT_STOP_RADIUS_METERS = 300;
export const DEFAULT_STOP_RADIUS_METERS_BY_TYPE: Record<StopType, number> = {
  train: 400,
  tram: 300,
  bus: 200,
};

/** Radii covered by the optional precomputed walkshed datasets. */
export const SHIPPED_STOP_RADII_METERS_BY_TYPE: Record<StopType, readonly number[]> = {
  train: [400, 450, 500, 550, 600],
  tram: [300, 350, 400, 450, 500],
  bus: [200, 250, 300],
};

export const MIN_STOP_RADIUS_METERS = 50;
export const MAX_STOP_RADIUS_METERS = 5000;
export const STOP_RADIUS_STEP_METERS = 10;
export const COVERAGE_SHAPE_STORAGE_KEY = 'karlsruhe-opnv-coverage-shape';
export const STOP_TYPE_VISIBILITY_STORAGE_KEY = 'karlsruhe-opnv-stop-type-visibility-v1';
export const REASONABLE_STREET_CROSSINGS_STORAGE_KEY =
  'karlsruhe-opnv-reasonable-street-crossings-v1';
export const DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS = true;

export type CoverageShape = 'circle' | 'walkshed';
export type StopRadiusByType = Record<StopType, number>;
export type StopTypeVisibilityByType = Record<StopType, boolean>;
export const DEFAULT_COVERAGE_SHAPE: CoverageShape = 'walkshed';
const DEFAULT_STOP_TYPE_VISIBILITY_BY_TYPE: StopTypeVisibilityByType = {
  train: true,
  tram: true,
  bus: false,
};

export function clampStopRadius(value: unknown, fallback = DEFAULT_STOP_RADIUS_METERS): number {
  if (value === null || value === undefined) return fallback;

  const normalized = typeof value === 'string' ? value.trim() : value;
  if (normalized === '') return fallback;

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_STOP_RADIUS_METERS, Math.max(MIN_STOP_RADIUS_METERS, Math.round(parsed)));
}

function readStoredRadius(stopType: StopType): unknown {
  const perTypeValue = getStorageItem(STOP_RADIUS_STORAGE_KEYS[stopType]);
  if (perTypeValue !== null) return perTypeValue;
  return getStorageItem(LEGACY_STOP_RADIUS_STORAGE_KEY);
}

export function getConfiguredStopRadius(stopType: StopType): number {
  return clampStopRadius(readStoredRadius(stopType), DEFAULT_STOP_RADIUS_METERS_BY_TYPE[stopType]);
}

export function getConfiguredStopRadii(): StopRadiusByType {
  return mapStopTypes((stopType) => getConfiguredStopRadius(stopType));
}

export function setConfiguredStopRadius(stopType: StopType, value: unknown): number {
  const radius = clampStopRadius(value, DEFAULT_STOP_RADIUS_METERS_BY_TYPE[stopType]);
  setStorageItem(STOP_RADIUS_STORAGE_KEYS[stopType], String(radius));
  return radius;
}

function parseCoverageShape(value: unknown): CoverageShape {
  return value === 'circle' ? 'circle' : 'walkshed';
}

export function getConfiguredCoverageShape(): CoverageShape {
  return parseCoverageShape(getStorageItem(COVERAGE_SHAPE_STORAGE_KEY));
}

export function setConfiguredCoverageShape(value: unknown): CoverageShape {
  const shape = parseCoverageShape(value);
  setStorageItem(COVERAGE_SHAPE_STORAGE_KEY, shape);
  return shape;
}

export function getAllowReasonableStreetCrossings(): boolean {
  return getStorageItem(REASONABLE_STREET_CROSSINGS_STORAGE_KEY) !== 'false';
}

export function setAllowReasonableStreetCrossings(value: boolean): boolean {
  setStorageItem(REASONABLE_STREET_CROSSINGS_STORAGE_KEY, String(value));
  return value;
}

function normalizeStopTypeVisibility(value: unknown): StopTypeVisibilityByType {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_STOP_TYPE_VISIBILITY_BY_TYPE };
  }

  const raw = value as Partial<Record<StopType, unknown>>;
  return mapStopTypes((stopType) =>
    typeof raw[stopType] === 'boolean'
      ? (raw[stopType] as boolean)
      : DEFAULT_STOP_TYPE_VISIBILITY_BY_TYPE[stopType],
  );
}

export function getConfiguredStopTypeVisibility(): StopTypeVisibilityByType {
  return normalizeStopTypeVisibility(readStorageJson(STOP_TYPE_VISIBILITY_STORAGE_KEY));
}

export function setConfiguredStopTypeVisibility(
  value: StopTypeVisibilityByType,
): StopTypeVisibilityByType {
  const visibility = normalizeStopTypeVisibility(value);
  writeStorageJson(STOP_TYPE_VISIBILITY_STORAGE_KEY, visibility);
  return visibility;
}

export const SETTINGS_STORAGE_KEYS: readonly string[] = [
  ...Object.values(STOP_RADIUS_STORAGE_KEYS),
  LEGACY_STOP_RADIUS_STORAGE_KEY,
  COVERAGE_SHAPE_STORAGE_KEY,
  STOP_TYPE_VISIBILITY_STORAGE_KEY,
  REASONABLE_STREET_CROSSINGS_STORAGE_KEY,
];

/**
 * Whether the given configuration is covered by the shipped polygons. Only
 * such configurations can be served entirely from the precomputed
 * dataset (see {@link loadShippedWalkshedPolygon}); anything else must be
 * computed live from Overpass. Kept here — beside the DEFAULT_* constants it
 * compares against — so the map preload, the config status message, and the
 * shipped-walkshed lookup share one source of truth.
 */
export function matchesShippedWalkshedConfiguration(
  radiusByType: StopRadiusByType,
  coverageShape: CoverageShape,
  allowReasonableStreetCrossings: boolean,
): boolean {
  return (
    coverageShape === DEFAULT_COVERAGE_SHAPE &&
    allowReasonableStreetCrossings === DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS &&
    STOP_TYPES.every((stopType) =>
      SHIPPED_STOP_RADII_METERS_BY_TYPE[stopType].includes(radiusByType[stopType]),
    )
  );
}

export const COVERAGE_SHAPE_DISPLAY_LABELS: Record<CoverageShape, string> = {
  circle: 'Kreis (Luftlinie)',
  walkshed: 'Fußweg-Polygon (OSM)',
};

export const COVERAGE_SHAPE_COMPACT_LABELS: Record<CoverageShape, string> = {
  circle: 'Kreis',
  walkshed: 'Fußweg-Polygon',
};
