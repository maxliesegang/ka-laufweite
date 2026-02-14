export type StopType = 'tram' | 'train' | 'custom';

export interface Stop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  type: StopType;
}

export type CustomStop = Stop & { type: 'custom' };
export type NewCustomStop = Pick<Stop, 'name' | 'lat' | 'lon'>;

function isStopType(value: unknown): value is StopType {
  return value === 'tram' || value === 'train' || value === 'custom';
}

export function isStop(value: unknown): value is Stop {
  if (!value || typeof value !== 'object') return false;
  const stop = value as Partial<Stop>;

  return (
    typeof stop.id === 'string' &&
    typeof stop.name === 'string' &&
    typeof stop.lat === 'number' &&
    Number.isFinite(stop.lat) &&
    typeof stop.lon === 'number' &&
    Number.isFinite(stop.lon) &&
    isStopType(stop.type)
  );
}
