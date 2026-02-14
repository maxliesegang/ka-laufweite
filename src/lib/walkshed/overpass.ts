import {
  OVERPASS_ENDPOINT_URLS,
  REQUEST_TIMEOUT_MS,
  WALKABLE_HIGHWAY_EXCLUDE_REGEX,
} from './constants';
import { bboxForStop } from './geo';
import type { OverpassNodeElement, OverpassResponse, OverpassWayElement } from './types';

function overpassFootwayQuery(lat: number, lon: number, radiusMeters: number): string {
  const bbox = bboxForStop(lat, lon, radiusMeters);

  return `
[out:json][timeout:25];
(
  way["highway"]
    ["highway"!~"${WALKABLE_HIGHWAY_EXCLUDE_REGEX}"]
    ["area"!="yes"]
    ["indoor"!="yes"]
    ["access"!~"private|no"]
    ["foot"!~"no"]
    (${bbox.south},${bbox.west},${bbox.north},${bbox.east});
);
(._;>;);
out body;
`;
}

function isNodeElement(value: unknown): value is OverpassNodeElement {
  if (!value || typeof value !== 'object') return false;
  const element = value as Partial<OverpassNodeElement>;

  return (
    element.type === 'node' &&
    typeof element.id === 'number' &&
    Number.isFinite(element.id) &&
    typeof element.lat === 'number' &&
    Number.isFinite(element.lat) &&
    typeof element.lon === 'number' &&
    Number.isFinite(element.lon)
  );
}

function isWayElement(value: unknown): value is OverpassWayElement {
  if (!value || typeof value !== 'object') return false;
  const element = value as Partial<OverpassWayElement>;

  return (
    element.type === 'way' &&
    typeof element.id === 'number' &&
    Number.isFinite(element.id) &&
    Array.isArray(element.nodes) &&
    element.nodes.every((nodeId) => typeof nodeId === 'number' && Number.isFinite(nodeId))
  );
}

function parseOverpassResponse(payload: unknown): OverpassResponse | null {
  if (!payload || typeof payload !== 'object') return null;
  const response = payload as Partial<OverpassResponse>;
  if (!Array.isArray(response.elements)) return null;

  return {
    elements: response.elements.filter(
      (element) => isNodeElement(element) || isWayElement(element),
    ),
  };
}

async function fetchFromEndpoint(endpoint: string, query: string): Promise<OverpassResponse> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Overpass status ${response.status}`);
  }

  const payload: unknown = await response.json();
  const parsed = parseOverpassResponse(payload);
  if (!parsed) {
    throw new Error('Invalid Overpass payload');
  }

  return parsed;
}

export async function fetchFootways(
  lat: number,
  lon: number,
  distanceMeters: number,
): Promise<OverpassResponse | null> {
  const query = overpassFootwayQuery(lat, lon, distanceMeters);
  for (const endpointUrl of OVERPASS_ENDPOINT_URLS) {
    try {
      return await fetchFromEndpoint(endpointUrl, query);
    } catch {
      continue;
    }
  }

  return null;
}
