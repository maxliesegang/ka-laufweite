import { isStop, isStopType, type CustomStop, type NewCustomStop, type StopType } from './types';
import { readStorageJson, writeStorageJson } from './storage';

export const CUSTOM_STOPS_STORAGE_KEY = 'karlsruhe-opnv-custom-stops';

function isCustomStop(value: unknown): value is CustomStop {
  return isStop(value) && value.isCustom === true;
}

interface LegacyCustomStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  type: 'custom';
  transitType?: unknown;
  customType?: unknown;
  stopType?: unknown;
}

function isLegacyCustomStop(value: unknown): value is LegacyCustomStop {
  if (!value || typeof value !== 'object') return false;
  const stop = value as Partial<LegacyCustomStop>;

  return (
    typeof stop.id === 'string' &&
    typeof stop.name === 'string' &&
    typeof stop.lat === 'number' &&
    Number.isFinite(stop.lat) &&
    typeof stop.lon === 'number' &&
    Number.isFinite(stop.lon) &&
    stop.type === 'custom'
  );
}

function legacyStopType(stop: LegacyCustomStop): StopType {
  const candidates = [stop.transitType, stop.customType, stop.stopType];
  for (const candidate of candidates) {
    if (isStopType(candidate)) return candidate;
  }

  return 'tram';
}

export function getCustomStops(): CustomStop[] {
  const parsed = readStorageJson(CUSTOM_STOPS_STORAGE_KEY);
  if (!Array.isArray(parsed)) return [];

  let changed = false;
  const stops: CustomStop[] = [];

  for (const entry of parsed) {
    if (isCustomStop(entry)) {
      stops.push(entry);
      continue;
    }

    if (!isLegacyCustomStop(entry)) continue;
    changed = true;
    stops.push({
      id: entry.id,
      name: entry.name,
      lat: entry.lat,
      lon: entry.lon,
      type: legacyStopType(entry),
      isCustom: true,
    });
  }

  if (changed || stops.length !== parsed.length) {
    writeCustomStops(stops);
  }

  return stops;
}

function writeCustomStops(stops: CustomStop[]): void {
  writeStorageJson(CUSTOM_STOPS_STORAGE_KEY, stops);
}

export function addCustomStop(input: NewCustomStop): CustomStop {
  const stops = getCustomStops();
  const stop: CustomStop = {
    ...input,
    id: `custom-${crypto.randomUUID()}`,
    isCustom: true,
  };

  stops.push(stop);
  writeCustomStops(stops);
  return stop;
}

export function removeCustomStop(stopId: string): boolean {
  const stops = getCustomStops();
  const filtered = stops.filter((s) => s.id !== stopId);

  if (filtered.length === stops.length) return false;

  writeCustomStops(filtered);
  return true;
}

export function clearCustomStops(): CustomStop[] {
  const stops = getCustomStops();
  if (stops.length === 0) return [];

  writeCustomStops([]);
  return stops;
}

export function updateCustomStopPosition(
  stopId: string,
  lat: number,
  lon: number,
): CustomStop | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const stops = getCustomStops();
  const index = stops.findIndex((stop) => stop.id === stopId);
  if (index < 0) return null;

  const updated: CustomStop = {
    ...stops[index],
    lat,
    lon,
  };
  stops[index] = updated;
  writeCustomStops(stops);
  return updated;
}
