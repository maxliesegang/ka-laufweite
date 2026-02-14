import type { StopType } from './types';

export const MAP_INITIAL_CENTER: [number, number] = [49.0069, 8.4037];
export const MAP_INITIAL_ZOOM = 13;

export const STOP_COLORS: Record<StopType, string> = {
  tram: '#e63946',
  train: '#457b9d',
  custom: '#2a9d8f',
};

export const STOP_MARKER_RADIUS: Record<StopType, number> = {
  tram: 5,
  train: 7,
  custom: 5,
};

export const STOP_TYPE_LABELS: Record<StopType, string> = {
  tram: 'Straßenbahn',
  train: 'Bahn / S-Bahn',
  custom: 'Eigene Haltestelle',
};
