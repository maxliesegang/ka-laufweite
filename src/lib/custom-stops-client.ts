import { isStop, type CustomStop, type NewCustomStop } from './types';

const CUSTOM_STOPS_STORAGE_KEY = 'karlsruhe-opnv-custom-stops';

function isCustomStop(value: unknown): value is CustomStop {
  return isStop(value) && value.type === 'custom';
}

export function getCustomStops(): CustomStop[] {
  try {
    const raw = localStorage.getItem(CUSTOM_STOPS_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isCustomStop) : [];
  } catch {
    return [];
  }
}

function writeCustomStops(stops: CustomStop[]): void {
  localStorage.setItem(CUSTOM_STOPS_STORAGE_KEY, JSON.stringify(stops));
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
