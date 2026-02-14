import { QUERY_PADDING_METERS } from './constants';
import type { LatLng } from './types';

export function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function metersPerLonDegree(latitude: number): number {
  return 111_320 * Math.max(0.2, Math.cos(toRadians(latitude)));
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const earthRadius = 6_371_000;
  const dLat = toRadians(b[0] - a[0]);
  const dLon = toRadians(b[1] - a[1]);
  const lat1 = toRadians(a[0]);
  const lat2 = toRadians(b[0]);

  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(x));
}

export function bboxForStop(lat: number, lon: number, radiusMeters: number) {
  const radius = radiusMeters + QUERY_PADDING_METERS;
  const latDelta = radius / 111_320;
  const lonDelta = radius / metersPerLonDegree(lat);

  return {
    south: lat - latDelta,
    west: lon - lonDelta,
    north: lat + latDelta,
    east: lon + lonDelta,
  };
}
