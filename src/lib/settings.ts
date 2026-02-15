import { getStorageItem, readStorageJson, setStorageItem, writeStorageJson } from './storage';
import { STOP_TYPE_CONFIG } from './stop-type-config';
import { mapStopTypes, type StopType } from './types';

export const LEGACY_STOP_RADIUS_STORAGE_KEY = 'karlsruhe-opnv-stop-radius-meters';
export const STOP_RADIUS_STORAGE_KEYS: Record<StopType, string> = mapStopTypes(
  (stopType) => `karlsruhe-opnv-stop-radius-meters-${stopType}`,
);
export const STOP_RADIUS_INPUT_IDS: Record<StopType, string> = mapStopTypes(
  (stopType) => STOP_TYPE_CONFIG[stopType].radiusInputId,
);

const DEFAULT_STOP_RADIUS_METERS = 300;
export const DEFAULT_STOP_RADIUS_METERS_BY_TYPE: Record<StopType, number> = mapStopTypes(
  () => DEFAULT_STOP_RADIUS_METERS,
);

export const MIN_STOP_RADIUS_METERS = 50;
export const MAX_STOP_RADIUS_METERS = 5000;
export const STOP_RADIUS_STEP_METERS = 10;
export const COVERAGE_SHAPE_STORAGE_KEY = 'karlsruhe-opnv-coverage-shape';
export const STOP_TYPE_VISIBILITY_STORAGE_KEY = 'karlsruhe-opnv-stop-type-visibility-v1';

export type CoverageShape = 'circle' | 'walkshed';
export type StopRadiusByType = Record<StopType, number>;
export type StopTypeVisibilityByType = Record<StopType, boolean>;
export const DEFAULT_COVERAGE_SHAPE: CoverageShape = 'walkshed';
const DEFAULT_STOP_TYPE_VISIBILITY_BY_TYPE: StopTypeVisibilityByType = mapStopTypes(() => true);

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
];

export const COVERAGE_SHAPE_DISPLAY_LABELS: Record<CoverageShape, string> = {
  circle: 'Kreis (Luftlinie)',
  walkshed: 'Fußweg-Polygon (OSM)',
};

export const COVERAGE_SHAPE_COMPACT_LABELS: Record<CoverageShape, string> = {
  circle: 'Kreis',
  walkshed: 'Fußweg-Polygon',
};
