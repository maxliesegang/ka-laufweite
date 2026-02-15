import { getStorageItem, setStorageItem } from './storage';

export const STOP_RADIUS_STORAGE_KEY = 'karlsruhe-opnv-stop-radius-meters';
export const DEFAULT_STOP_RADIUS_METERS = 300;
export const MIN_STOP_RADIUS_METERS = 50;
export const MAX_STOP_RADIUS_METERS = 5000;
export const STOP_RADIUS_STEP_METERS = 10;
export const COVERAGE_SHAPE_STORAGE_KEY = 'karlsruhe-opnv-coverage-shape';

export type CoverageShape = 'circle' | 'walkshed';
export const DEFAULT_COVERAGE_SHAPE: CoverageShape = 'walkshed';

export function clampStopRadius(value: unknown): number {
  if (value === null || value === undefined) return DEFAULT_STOP_RADIUS_METERS;

  const normalized = typeof value === 'string' ? value.trim() : value;
  if (normalized === '') return DEFAULT_STOP_RADIUS_METERS;

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return DEFAULT_STOP_RADIUS_METERS;
  return Math.min(MAX_STOP_RADIUS_METERS, Math.max(MIN_STOP_RADIUS_METERS, Math.round(parsed)));
}

export function getConfiguredStopRadius(): number {
  return clampStopRadius(getStorageItem(STOP_RADIUS_STORAGE_KEY));
}

export function setConfiguredStopRadius(value: unknown): number {
  const radius = clampStopRadius(value);
  setStorageItem(STOP_RADIUS_STORAGE_KEY, String(radius));
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

export const COVERAGE_SHAPE_DISPLAY_LABELS: Record<CoverageShape, string> = {
  circle: 'Kreis (Luftlinie)',
  walkshed: 'Fußweg-Polygon (OSM)',
};

export const COVERAGE_SHAPE_COMPACT_LABELS: Record<CoverageShape, string> = {
  circle: 'Kreis',
  walkshed: 'Fußweg-Polygon',
};
