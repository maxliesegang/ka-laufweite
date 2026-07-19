// Only instances that send `Access-Control-Allow-Origin` belong here — a static
// site calls these directly from the browser. Note: on error responses (429/504)
// even CORS-capable instances drop that header, so the browser surfaces a throttled
// request as a generic "CORS failed". A broad pool spreads load and keeps a
// fallback alive when one instance is rate-limiting.
export const OVERPASS_ENDPOINT_URLS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export const WALKABLE_HIGHWAY_EXCLUDE_REGEX =
  'motorway|motorway_link|trunk|trunk_link|construction|proposed|bus_guideway|raceway|bridleway|corridor|escape';
export const REQUEST_TIMEOUT_MS = 35_000;
export const SNAP_DISTANCE_METERS = 250;
export const QUERY_PADDING_METERS = 80;
export const POINT_KEY_DECIMALS = 7;
export const LOCAL_POINT_KEY_DECIMALS = 2;
export const MIN_EFFECTIVE_WALK_DISTANCE_METERS = 1;
export const CONCAVE_HULL_CONCAVITY = 2.2;
export const CONCAVE_HULL_LENGTH_THRESHOLD_METERS = 0;
export const START_NODE_CANDIDATE_LIMIT = 24;
export const MIN_BOUNDARY_POINTS_FOR_RELIABLE_POLYGON = 8;
export const MAX_START_NODE_FALLBACK_DISTANCE_DELTA_METERS = 40;
export const MAX_REASONABLE_STREET_CROSSING_METERS = 30;
export const MIN_REASONABLE_STREET_CROSSING_METERS = 3;

// --- Connectivity-aware seed snapping (see graph.ts findNearestEdgeSeeds) ---

/**
 * Beyond the plain nearest edge, a stop whose nearest edge sits on a tiny
 * disconnected stub (common for rail/tram platforms, where the platform-side
 * footway is not joined to the street network in OSM) also snaps to the nearest
 * edge of a substantial component within this distance. The walkshed then
 * spreads across the real network instead of collapsing onto the stub. Kept
 * small so a bridge can never jump a wide barrier (rail corridor, river).
 */
export const COMPONENT_BRIDGE_DISTANCE_METERS = 40;

/**
 * A graph component counts as substantial — worth bridging a stub to — when its
 * node count is at least this floor and at least SUBSTANTIAL_COMPONENT_FRACTION
 * of the largest component. The fraction keeps the test scale-invariant across
 * sparse and dense areas; the floor guards tiny graphs.
 */
export const MIN_SUBSTANTIAL_COMPONENT_NODES = 30;
export const SUBSTANTIAL_COMPONENT_FRACTION = 0.1;

// --- Batched shared-network loading (see service.ts buildWalkshedPolygons) ---

/**
 * Documented walking-radius buckets used to key the shared area/network cache.
 * A batch is padded by the smallest bucket that is >= its largest stop radius,
 * so a graph fetched for a larger bucket fully contains — and can serve — any
 * request with a smaller radius in the same area. The final bucket must cover
 * MAX_STOP_RADIUS_METERS (5000) so every allowed radius maps to a bucket.
 */
export const WALKSHED_RADIUS_BUCKETS_METERS = [300, 600, 1200, 2400, 5000] as const;

/**
 * Decimal places the shared area cache rounds bounding boxes to (~110 m at 3
 * decimals). Bounds are rounded strictly outward, so the rounded box always
 * contains the real one and the padded query bounds stay a safe superset.
 */
export const WALKSHED_QUERY_AREA_PRECISION_DECIMALS = 3;

/** LRU bound on how many shared network responses / graph variants are kept. */
export const MAX_WALKSHED_AREA_CACHE_ENTRIES = 12;

/** Memory-oriented cache budgets. The newest entry is retained even when one
 * unusually large query exceeds a budget, but older areas are evicted. */
export const MAX_CACHED_OVERPASS_ELEMENTS = 300_000;
export const MAX_CACHED_WALK_GRAPH_NODES = 200_000;
