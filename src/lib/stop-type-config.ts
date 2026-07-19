import { STOP_TYPES, type StopType } from './types';

export interface StopTypeConfig {
  label: string;
  compactLabel: string;
  color: string;
  markerRadius: number;
  radiusInputId: string;
  radiusInputName: string;
}

export const STOP_TYPE_CONFIG: Record<StopType, StopTypeConfig> = {
  tram: {
    label: 'Straßenbahn',
    compactLabel: 'Tram',
    color: '#e63946',
    markerRadius: 5,
    radiusInputId: 'radius-tram-input',
    radiusInputName: 'radiusTram',
  },
  train: {
    label: 'Bahn / S-Bahn',
    compactLabel: 'Bahn',
    color: '#457b9d',
    markerRadius: 7,
    radiusInputId: 'radius-train-input',
    radiusInputName: 'radiusTrain',
  },
  bus: {
    label: 'Bus',
    compactLabel: 'Bus',
    color: '#2a9d8f',
    markerRadius: 5,
    radiusInputId: 'radius-bus-input',
    radiusInputName: 'radiusBus',
  },
};

function buildStopTypeEntries(order: readonly StopType[]) {
  return order.map((type) => ({ type, ...STOP_TYPE_CONFIG[type] }));
}

export const STOP_TYPE_ENTRIES = buildStopTypeEntries(STOP_TYPES);

export const STOP_TYPES_CONFIG_ORDER: readonly StopType[] = ['train', 'tram', 'bus'];
export const STOP_TYPE_ENTRIES_CONFIG_ORDER = buildStopTypeEntries(STOP_TYPES_CONFIG_ORDER);

export function formatStopRadiusSummary(
  radiusByType: Record<StopType, number>,
  order: readonly StopType[] = STOP_TYPES,
): string {
  return order
    .map((stopType) => `${STOP_TYPE_CONFIG[stopType].compactLabel} ${radiusByType[stopType]} m`)
    .join(', ');
}
