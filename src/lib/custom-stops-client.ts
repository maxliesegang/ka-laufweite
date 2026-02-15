import { isStop, type CustomStop, type NewCustomStop } from './types';
import { readStorageJson, writeStorageJson } from './storage';

const CUSTOM_STOPS_STORAGE_KEY = 'karlsruhe-opnv-custom-stops';

function isCustomStop(value: unknown): value is CustomStop {
  return isStop(value) && value.type === 'custom';
}

export function getCustomStops(): CustomStop[] {
  const parsed = readStorageJson(CUSTOM_STOPS_STORAGE_KEY);
  return Array.isArray(parsed) ? parsed.filter(isCustomStop) : [];
}

function writeCustomStops(stops: CustomStop[]): void {
  writeStorageJson(CUSTOM_STOPS_STORAGE_KEY, stops);
}

export function addCustomStop(input: NewCustomStop): CustomStop {
  const stops = getCustomStops();
  const stop: CustomStop = {
    ...input,
    id: `custom-${crypto.randomUUID()}`,
    type: 'custom',
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
