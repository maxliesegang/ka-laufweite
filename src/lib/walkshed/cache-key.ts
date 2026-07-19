/**
 * Single source of truth for the walkshed cache-key format.
 *
 * A walkshed polygon is cached per stop, algorithm version, walking distance,
 * and normalized coordinates. The runtime cache, persistent cache, and overlay
 * manager all address entries by this key.
 */
const WALKSHED_ALGORITHM_VERSION = 2;

export function walkshedCacheKey(
  stopId: string,
  distanceMeters: number,
  lat?: number,
  lon?: number,
  allowReasonableStreetCrossings = true,
): string {
  const coordinateSuffix =
    lat === undefined || lon === undefined ? '' : `:${lat.toFixed(6)}:${lon.toFixed(6)}`;
  const crossingMode = allowReasonableStreetCrossings ? 'crossings' : 'mapped-only';
  return `${stopId}:v${WALKSHED_ALGORITHM_VERSION}:${crossingMode}:${distanceMeters}${coordinateSuffix}`;
}

/**
 * Prefix matching every walkshed cache entry for a stop, across all distances.
 * Used to invalidate a stop's entries when it moves or is removed.
 */
export function walkshedCacheKeyPrefixForStop(stopId: string): string {
  return `${stopId}:`;
}
