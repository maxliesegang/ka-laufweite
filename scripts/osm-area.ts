/** Geographic scope of the data refresh, shared by the stop snapshot and the
 *  OSM extract the walkshed build routes on. */
import { padBoundingBox } from '../src/lib/walkshed/geo.ts';
import type { BoundingBox } from '../src/lib/walkshed/types.ts';

/** Area the stop snapshot covers (the KVV network). */
export const KVV_BOUNDS: BoundingBox = { south: 48.55, west: 7.75, north: 49.3, east: 8.95 };

/**
 * Margin the footway extract keeps around KVV_BOUNDS. Every walkshed query area
 * is a stop's batch box padded by its radius bucket plus QUERY_PADDING_METERS,
 * so this must stay above the largest bucket a shipped radius maps to. The
 * walkshed build refuses any query area that leaves the extract.
 */
const FOOTWAY_EXTRACT_PADDING_METERS = 3_000;

export const FOOTWAY_EXTRACT_BOUNDS: BoundingBox = padBoundingBox(
  KVV_BOUNDS,
  FOOTWAY_EXTRACT_PADDING_METERS,
);

/** Geofabrik regions that together cover FOOTWAY_EXTRACT_BOUNDS. */
export const GEOFABRIK_REGIONS = [
  'europe/germany/baden-wuerttemberg',
  'europe/germany/rheinland-pfalz',
  'europe/france/alsace',
] as const;
