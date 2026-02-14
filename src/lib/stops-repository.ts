import { getCustomStops } from './custom-stops-client';
import { isStop, type Stop } from './types';

const OSM_STOPS_URL = `${import.meta.env.BASE_URL}data/osm-stops.json`;

let cachedOsmStops: Stop[] | null = null;
let inFlightRequest: Promise<Stop[]> | null = null;

async function fetchOsmStops(): Promise<Stop[]> {
  if (cachedOsmStops) return cachedOsmStops;
  if (inFlightRequest) return inFlightRequest;

  inFlightRequest = fetch(OSM_STOPS_URL)
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${OSM_STOPS_URL}`);
      const payload: unknown = await res.json();
      if (!Array.isArray(payload)) return [];
      return payload.filter(isStop).filter((s) => s.type !== 'custom');
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
