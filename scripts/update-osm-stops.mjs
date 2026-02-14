import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const outputPath = join(import.meta.dirname, '..', 'public', 'data', 'osm-stops.json');

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_ROUNDS = 2;
const KVV_BBOX = { south: 48.55, west: 7.75, north: 49.3, east: 8.95 };

const KVV_QUERY = `
[out:json][timeout:30];
(
  node["railway"="tram_stop"](${KVV_BBOX.south},${KVV_BBOX.west},${KVV_BBOX.north},${KVV_BBOX.east});
  node["railway"="station"](${KVV_BBOX.south},${KVV_BBOX.west},${KVV_BBOX.north},${KVV_BBOX.east});
  node["railway"="halt"](${KVV_BBOX.south},${KVV_BBOX.west},${KVV_BBOX.north},${KVV_BBOX.east});
);
out body;
`;

function classifyStop(tags = {}) {
  if (tags.railway === 'tram_stop') return 'tram';
  if (tags.railway === 'station' || tags.railway === 'halt') return 'train';
  return 'tram';
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
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Overpass API error: ${response.status}`);
  }

  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchStops() {
  let lastError = null;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const payload = await fetchOverpass(endpoint, KVV_QUERY);
        const elements = Array.isArray(payload?.elements) ? payload.elements.filter(isElement) : [];

        return elements
          .map((element) => ({
            id: `osm-${element.id}`,
            name:
              typeof element?.tags?.name === 'string'
                ? element.tags.name
                : 'Unbekannte Haltestelle',
            lat: element.lat,
            lon: element.lon,
            type: classifyStop(element.tags ?? {}),
          }))
          .sort((a, b) => a.name.localeCompare(b.name, 'de'));
      } catch (error) {
        lastError = error;
      }
    }

    if (round < MAX_ROUNDS - 1) {
      await sleep(1000 * (round + 1));
    }
  }

  throw lastError ?? new Error('Failed to fetch stops from Overpass');
}

const stops = await fetchStops();
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(stops, null, 2));
console.log(`Wrote ${stops.length} stops to ${outputPath}`);
