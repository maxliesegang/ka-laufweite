import {
  OVERPASS_ENDPOINT_URLS,
  REQUEST_TIMEOUT_MS,
  WALKABLE_HIGHWAY_EXCLUDE_REGEX,
} from './constants';
import { bboxForStop } from './geo';
import type { OverpassNodeElement, OverpassResponse, OverpassWayElement } from './types';
import { getStorageItem, setStorageItem } from '../storage';

const OVERPASS_PREFERRED_ENDPOINT_STORAGE_KEY = 'karlsruhe-opnv-overpass-endpoint-v1';
const LATENCY_SMOOTHING = 0.25;
const UNKNOWN_ENDPOINT_LATENCY_MS = 700;
const FAILURE_PENALTY_MS = 1_500;
const MAX_FAILURE_STREAK = 6;
const PREFERRED_ENDPOINT_BONUS_MS = 120;

interface EndpointStats {
  latencyMs: number;
  failureStreak: number;
}

const endpointStatsByUrl = new Map<string, EndpointStats>();
let preferredEndpointUrl: string | null = null;
let preferredEndpointLoaded = false;

function uniqueEndpointUrls(): string[] {
  return [...new Set(OVERPASS_ENDPOINT_URLS)];
}

function loadPreferredEndpointFromStorage(): void {
  if (preferredEndpointLoaded) return;
  preferredEndpointLoaded = true;

  const saved = getStorageItem(OVERPASS_PREFERRED_ENDPOINT_STORAGE_KEY);
  if (saved && uniqueEndpointUrls().includes(saved)) {
    preferredEndpointUrl = saved;
  }
}

function persistPreferredEndpoint(endpointUrl: string): void {
  setStorageItem(OVERPASS_PREFERRED_ENDPOINT_STORAGE_KEY, endpointUrl);
}

function endpointScore(endpointUrl: string): number {
  const stats = endpointStatsByUrl.get(endpointUrl);
  const baseScore = stats
    ? stats.latencyMs + stats.failureStreak * FAILURE_PENALTY_MS
    : UNKNOWN_ENDPOINT_LATENCY_MS;

  return preferredEndpointUrl === endpointUrl ? baseScore - PREFERRED_ENDPOINT_BONUS_MS : baseScore;
}

function orderedEndpointUrls(): string[] {
  const endpoints = uniqueEndpointUrls();
  const defaultOrder = new Map(endpoints.map((endpoint, index) => [endpoint, index]));

  return [...endpoints].sort((a, b) => {
    const scoreDelta = endpointScore(a) - endpointScore(b);
    if (scoreDelta !== 0) return scoreDelta;

    return (defaultOrder.get(a) ?? 0) - (defaultOrder.get(b) ?? 0);
  });
}

function markEndpointSuccess(endpointUrl: string, durationMs: number): void {
  const duration = Math.max(1, Math.round(durationMs));
  const previous = endpointStatsByUrl.get(endpointUrl);
  const latencyMs = previous
    ? Math.round(previous.latencyMs * (1 - LATENCY_SMOOTHING) + duration * LATENCY_SMOOTHING)
    : duration;

  endpointStatsByUrl.set(endpointUrl, { latencyMs, failureStreak: 0 });

  if (preferredEndpointUrl !== endpointUrl) {
    preferredEndpointUrl = endpointUrl;
    persistPreferredEndpoint(endpointUrl);
  }
}

function markEndpointFailure(endpointUrl: string): void {
  const previous = endpointStatsByUrl.get(endpointUrl);
  endpointStatsByUrl.set(endpointUrl, {
    latencyMs: previous?.latencyMs ?? UNKNOWN_ENDPOINT_LATENCY_MS,
    failureStreak: Math.min(MAX_FAILURE_STREAK, (previous?.failureStreak ?? 0) + 1),
  });
}

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

export type FootwayFetchResult =
  | { status: 'ok'; response: OverpassResponse }
  | { status: 'all-endpoints-failed' };

export async function fetchFootways(
  lat: number,
  lon: number,
  distanceMeters: number,
): Promise<FootwayFetchResult> {
  loadPreferredEndpointFromStorage();
  const query = overpassFootwayQuery(lat, lon, distanceMeters);
  const orderedEndpoints = orderedEndpointUrls();

  for (const endpointUrl of orderedEndpoints) {
    const startedAt = Date.now();
    try {
      const result = await fetchFromEndpoint(endpointUrl, query);
      const durationMs = Date.now() - startedAt;
      markEndpointSuccess(endpointUrl, durationMs);
      return { status: 'ok', response: result };
    } catch {
      markEndpointFailure(endpointUrl);
      continue;
    }
  }

  return { status: 'all-endpoints-failed' };
}
