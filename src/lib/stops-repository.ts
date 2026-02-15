import { getCustomStops } from './custom-stops-client';
import { isStop, type Stop } from './types';

const OSM_STOPS_URL = `${import.meta.env.BASE_URL}data/osm-stops.json`;
const OSM_FETCH_CACHE_MODE: RequestCache = 'default';

let cachedOsmStops: Stop[] | null = null;
let inFlightRequest: Promise<Stop[]> | null = null;

function sanitizeOsmStops(payload: unknown): Stop[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter(isStop).filter((stop) => stop.isCustom !== true);
}

async function fetchOsmStops(): Promise<Stop[]> {
  if (cachedOsmStops) return cachedOsmStops;
  if (inFlightRequest) return inFlightRequest;

  inFlightRequest = fetch(OSM_STOPS_URL, { cache: OSM_FETCH_CACHE_MODE })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${OSM_STOPS_URL}`);
      return sanitizeOsmStops((await res.json()) as unknown);
    })
    .then((stops) => {
      cachedOsmStops = stops;
      return stops;
    })
    .finally(() => {
      inFlightRequest = null;
    });

  return inFlightRequest;
}

export async function loadAllStops(): Promise<Stop[]> {
  const osmStops = await fetchOsmStops();
  return [...osmStops, ...getCustomStops()];
}
