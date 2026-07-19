/**
 * Single source of truth for the walkshed cache-key format.
 *
 * A walkshed polygon is cached per stop and per walking distance. The runtime
 * cache, the persistent cache, and the overlay manager all address entries by
 * this key, so the format lives here rather than being re-spelled in each module.
 */
export function walkshedCacheKey(stopId: string, distanceMeters: number): string {
  return `${stopId}:${distanceMeters}`;
}

/**
 * Prefix matching every walkshed cache entry for a stop, across all distances.
 * Used to invalidate a stop's entries when it moves or is removed.
 */
export function walkshedCacheKeyPrefixForStop(stopId: string): string {
  return `${stopId}:`;
}
