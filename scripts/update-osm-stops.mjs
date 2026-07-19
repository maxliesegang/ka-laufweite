import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const outputPath = join(import.meta.dirname, '..', 'public', 'data', 'osm-stops.json');

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_ROUNDS = 2;
const KVV_BBOX = { south: 48.55, west: 7.75, north: 49.3, east: 8.95 };
const UNKNOWN_STOP_NAME = 'Unbekannte Haltestelle';
const USER_AGENT = 'ka-laufweite-stop-updater/1.0 (+https://github.com/maxliesegang/ka-laufweite)';

const KVV_QUERY = `
[out:json][timeout:30];
(
  node["railway"="tram_stop"](${KVV_BBOX.south},${KVV_BBOX.west},${KVV_BBOX.north},${KVV_BBOX.east});
  node["railway"="station"](${KVV_BBOX.south},${KVV_BBOX.west},${KVV_BBOX.north},${KVV_BBOX.east});
  node["railway"="halt"](${KVV_BBOX.south},${KVV_BBOX.west},${KVV_BBOX.north},${KVV_BBOX.east});
  node["highway"="bus_stop"](${KVV_BBOX.south},${KVV_BBOX.west},${KVV_BBOX.north},${KVV_BBOX.east});
  node["amenity"="bus_station"](${KVV_BBOX.south},${KVV_BBOX.west},${KVV_BBOX.north},${KVV_BBOX.east});
);
out body;
`;

function classifyStop(tags = {}) {
  if (tags.railway === 'tram_stop') return 'tram';
  if (tags.railway === 'station' || tags.railway === 'halt') return 'train';
  if (tags.highway === 'bus_stop' || tags.amenity === 'bus_station') return 'bus';
  return null;
}

function isElement(value) {
  return (
    value &&
    typeof value === 'object' &&
    Number.isFinite(value.id) &&
    Number.isFinite(value.lat) &&
    Number.isFinite(value.lon)
  );
}

async function fetchOverpass(endpoint, query) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const responseBody = (await response.text()).replaceAll(/\s+/g, ' ').trim().slice(0, 500);
    const detail = responseBody ? `: ${responseBody}` : '';
    throw new Error(`${endpoint} returned ${response.status} ${response.statusText}${detail}`);
  }

  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchStops() {
  const errors = [];

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const payload = await fetchOverpass(endpoint, KVV_QUERY);
        const elements = Array.isArray(payload?.elements) ? payload.elements.filter(isElement) : [];
        return elements
          .map((element) => ({
            id: `osm-${element.id}`,
            name: typeof element?.tags?.name === 'string' ? element.tags.name : UNKNOWN_STOP_NAME,
            lat: element.lat,
            lon: element.lon,
            type: classifyStop(element.tags ?? {}),
          }))
          .filter((stop) => stop.type !== null)
          .sort((a, b) => a.name.localeCompare(b.name, 'de'));
      } catch (error) {
        const reason = error instanceof Error ? error : new Error(String(error));
        errors.push(reason);
        console.warn(
          `Overpass request failed (round ${round + 1}/${MAX_ROUNDS}): ${reason.message}`,
        );
      }
    }

    if (round < MAX_ROUNDS - 1) {
      await sleep(1000 * (round + 1));
    }
  }

  throw new AggregateError(errors, 'Failed to fetch stops from all Overpass endpoints');
}

const stops = await fetchStops();
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(stops, null, 2));
console.log(`Wrote ${stops.length} stops to ${outputPath}`);
