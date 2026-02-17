import { readStorageJson, removeStorageItem, writeStorageJson } from './storage';

export const WALKSHED_DISABLED_STOPS_STORAGE_KEY = 'karlsruhe-opnv-walkshed-disabled-stop-ids-v1';

function normalizeStopIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const normalized = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;

    const stopId = item.trim();
    if (stopId.length === 0) continue;
    normalized.add(stopId);
  }

  return [...normalized].sort((a, b) => a.localeCompare(b));
}

function readDisabledStopIds(): string[] {
  return normalizeStopIds(readStorageJson(WALKSHED_DISABLED_STOPS_STORAGE_KEY));
}

function writeDisabledStopIds(stopIds: string[]): void {
  if (stopIds.length === 0) {
    removeStorageItem(WALKSHED_DISABLED_STOPS_STORAGE_KEY);
    return;
  }

  writeStorageJson(WALKSHED_DISABLED_STOPS_STORAGE_KEY, stopIds);
}

export function getWalkshedDisabledStopIds(): Set<string> {
  return new Set(readDisabledStopIds());
}

export function setWalkshedDisabledForStop(stopId: string, disabled: boolean): boolean {
  const normalizedStopId = stopId.trim();
  if (normalizedStopId.length === 0) return false;

  const stopIds = getWalkshedDisabledStopIds();
  const wasDisabled = stopIds.has(normalizedStopId);
  if (wasDisabled === disabled) return wasDisabled;

  if (disabled) {
    stopIds.add(normalizedStopId);
  } else {
    stopIds.delete(normalizedStopId);
  }

  writeDisabledStopIds([...stopIds].sort((a, b) => a.localeCompare(b)));
  return disabled;
}

export function clearWalkshedDisabledStops(): number {
  const disabledStopIds = readDisabledStopIds();
  if (disabledStopIds.length > 0) {
    removeStorageItem(WALKSHED_DISABLED_STOPS_STORAGE_KEY);
  }

  return disabledStopIds.length;
}
