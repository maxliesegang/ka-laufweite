import type { Feature, FeatureCollection, Polygon } from 'geojson';

const EARTH_RADIUS_METERS = 6_371_008.8;
const CIRCLE_SEGMENTS = 64;

export type PolygonFeature = Feature<Polygon, { stopId: string; color: string }>;

export function emptyPolygonCollection(): FeatureCollection<Polygon, PolygonFeature['properties']> {
  return { type: 'FeatureCollection', features: [] };
}

export function circlePolygon(
  stopId: string,
  lat: number,
  lon: number,
  radiusMeters: number,
  color: string,
): PolygonFeature {
  const angularDistance = radiusMeters / EARTH_RADIUS_METERS;
  const centerLat = (lat * Math.PI) / 180;
  const centerLon = (lon * Math.PI) / 180;
  const coordinates: [number, number][] = [];

  for (let index = 0; index <= CIRCLE_SEGMENTS; index += 1) {
    const bearing = (index / CIRCLE_SEGMENTS) * Math.PI * 2;
    const pointLat = Math.asin(
      Math.sin(centerLat) * Math.cos(angularDistance) +
        Math.cos(centerLat) * Math.sin(angularDistance) * Math.cos(bearing),
    );
    const pointLon =
      centerLon +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(centerLat),
        Math.cos(angularDistance) - Math.sin(centerLat) * Math.sin(pointLat),
      );
    coordinates.push([(pointLon * 180) / Math.PI, (pointLat * 180) / Math.PI]);
  }

  return {
    type: 'Feature',
    properties: { stopId, color },
    geometry: { type: 'Polygon', coordinates: [coordinates] },
  };
}
