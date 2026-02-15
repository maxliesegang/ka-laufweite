export const OVERPASS_ENDPOINT_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];

export const WALKABLE_HIGHWAY_EXCLUDE_REGEX =
  'motorway|motorway_link|trunk|trunk_link|construction|proposed|bus_guideway|raceway|bridleway|corridor|escape';
export const REQUEST_TIMEOUT_MS = 18_000;
export const SNAP_DISTANCE_METERS = 250;
export const QUERY_PADDING_METERS = 80;
export const GRAPH_CACHE_COORD_PRECISION = 4;
export const POINT_KEY_DECIMALS = 7;
export const LOCAL_POINT_KEY_DECIMALS = 2;
export const MIN_EFFECTIVE_WALK_DISTANCE_METERS = 1;
export const CONCAVE_HULL_CONCAVITY = 2.2;
export const CONCAVE_HULL_LENGTH_THRESHOLD_METERS = 0;
export const START_NODE_CANDIDATE_LIMIT = 24;
export const MIN_BOUNDARY_POINTS_FOR_RELIABLE_POLYGON = 8;
export const MAX_START_NODE_FALLBACK_DISTANCE_DELTA_METERS = 40;
