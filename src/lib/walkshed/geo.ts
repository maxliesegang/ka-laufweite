import { QUERY_PADDING_METERS } from './constants';
import type { BoundingBox, LatLng } from './types';

export const METERS_PER_LAT_DEGREE = 111_320;

export function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function metersPerLonDegree(latitude: number): number {
  return METERS_PER_LAT_DEGREE * Math.max(0.2, Math.cos(toRadians(latitude)));
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

/**
 * Grow a bounding box outward by at least `paddingMeters` on every side.
 * Longitude uses the poleward padded edge, where a degree is shortest, so the
 * requested margin is preserved throughout the box.
 */
export function padBoundingBox(bounds: BoundingBox, paddingMeters: number): BoundingBox {
  const latDelta = paddingMeters / METERS_PER_LAT_DEGREE;
  const south = bounds.south - latDelta;
  const north = bounds.north + latDelta;
  const polewardLatitude = Math.max(Math.abs(south), Math.abs(north));
  const lonDelta = paddingMeters / metersPerLonDegree(polewardLatitude);

  return {
    south,
    west: bounds.west - lonDelta,
    north,
    east: bounds.east + lonDelta,
  };
}

/** Smallest bounding box containing every point, or null when given none. */
export function boundsContaining(points: LatLng[]): BoundingBox | null {
  if (points.length === 0) return null;

  let south = Number.POSITIVE_INFINITY;
  let west = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  for (const [lat, lon] of points) {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lon);
    east = Math.max(east, lon);
  }

  return { south, west, north, east };
}

export function boundingBoxForStop(lat: number, lon: number, radiusMeters: number): BoundingBox {
  return padBoundingBox(
    { south: lat, west: lon, north: lat, east: lon },
    radiusMeters + QUERY_PADDING_METERS,
  );
}
