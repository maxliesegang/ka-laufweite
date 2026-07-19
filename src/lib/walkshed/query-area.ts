import {
  QUERY_PADDING_METERS,
  WALKSHED_QUERY_AREA_PRECISION_DECIMALS,
  WALKSHED_RADIUS_BUCKETS_METERS,
} from './constants';
import { boundsContaining, metersPerLonDegree, padBoundingBox } from './geo';
import type { BoundingBox, LatLng } from './types';

export interface WalkshedQueryOrigin {
  lat: number;
  lon: number;
  radiusMeters: number;
}

export interface WalkshedQueryArea {
  radiusBucketMeters: number;
  cacheKey: string;
  bounds: BoundingBox;
  approximateAreaSquareMeters: number;
}

export function getRadiusBucketMeters(radiusMeters: number): number {
  for (const bucket of WALKSHED_RADIUS_BUCKETS_METERS) {
    if (radiusMeters <= bucket) return bucket;
  }
  return Math.max(
    radiusMeters,
    WALKSHED_RADIUS_BUCKETS_METERS[WALKSHED_RADIUS_BUCKETS_METERS.length - 1],
  );
}

function quantizeBoundsOutward(bounds: BoundingBox): BoundingBox {
  const factor = 10 ** WALKSHED_QUERY_AREA_PRECISION_DECIMALS;
  return {
    south: Math.floor(bounds.south * factor) / factor,
    west: Math.floor(bounds.west * factor) / factor,
    north: Math.ceil(bounds.north * factor) / factor,
    east: Math.ceil(bounds.east * factor) / factor,
  };
}

function areaCacheKey(bounds: BoundingBox, bucketMeters: number): string {
  const decimals = WALKSHED_QUERY_AREA_PRECISION_DECIMALS;
  return [bounds.south, bounds.west, bounds.north, bounds.east]
    .map((value) => value.toFixed(decimals))
    .concat(String(bucketMeters))
    .join(':');
}

export function approximateBoundsAreaSquareMeters(bounds: BoundingBox): number {
  const centerLatitude = (bounds.south + bounds.north) / 2;
  const height = Math.max(0, bounds.north - bounds.south) * 111_320;
  const width = Math.max(0, bounds.east - bounds.west) * metersPerLonDegree(centerLatitude);
  return height * width;
}

export function createWalkshedQueryArea(
  origins: readonly WalkshedQueryOrigin[],
): WalkshedQueryArea | null {
  if (origins.length === 0) return null;
  const maxRadius = Math.max(...origins.map((origin) => origin.radiusMeters));
  const bucketMeters = getRadiusBucketMeters(maxRadius);
  const covering = boundsContaining(origins.map((origin): LatLng => [origin.lat, origin.lon]));
  if (!covering) return null;

  const quantized = quantizeBoundsOutward(covering);
  const bounds = padBoundingBox(quantized, bucketMeters + QUERY_PADDING_METERS);
  return {
    radiusBucketMeters: bucketMeters,
    cacheKey: areaCacheKey(quantized, bucketMeters),
    bounds,
    approximateAreaSquareMeters: approximateBoundsAreaSquareMeters(bounds),
  };
}
