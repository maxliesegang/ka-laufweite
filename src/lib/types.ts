export const STOP_TYPES = ['tram', 'train', 'bus'] as const;
export type StopType = (typeof STOP_TYPES)[number];

export function mapStopTypes<T>(mapper: (stopType: StopType) => T): Record<StopType, T> {
  return Object.fromEntries(STOP_TYPES.map((stopType) => [stopType, mapper(stopType)])) as Record<
    StopType,
    T
  >;
}

export function stopTypeRecordChanged<T>(
  nextValueByType: Record<StopType, T>,
  currentValueByType: Record<StopType, T>,
  order: readonly StopType[] = STOP_TYPES,
): boolean {
  return order.some((stopType) => nextValueByType[stopType] !== currentValueByType[stopType]);
}

export interface Stop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  type: StopType;
  isCustom?: boolean;
}

export type CustomStop = Stop & { isCustom: true };
export type NewCustomStop = Pick<Stop, 'name' | 'lat' | 'lon' | 'type'>;

export function isStopType(value: unknown): value is StopType {
  return typeof value === 'string' && STOP_TYPES.includes(value as StopType);
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
    isStopType(stop.type) &&
    (stop.isCustom === undefined || typeof stop.isCustom === 'boolean')
  );
}
