import {
  OVERPASS_ENDPOINT_URLS,
  REQUEST_TIMEOUT_MS,
  WALKABLE_HIGHWAY_EXCLUDE_REGEX,
} from './constants';
import { boundingBoxForStop } from './geo';
import type {
  BoundingBox,
  OverpassNodeElement,
  OverpassResponse,
  OverpassWayElement,
} from './types';
import { getStorageItem, setStorageItem } from '../storage';

const OVERPASS_PREFERRED_ENDPOINT_STORAGE_KEY = 'karlsruhe-opnv-overpass-endpoint-v1';
const LATENCY_SMOOTHING = 0.25;
const UNKNOWN_ENDPOINT_LATENCY_MS = 700;
const FAILURE_PENALTY_MS = 1_500;
const MAX_FAILURE_STREAK = 6;
const PREFERRED_ENDPOINT_BONUS_MS = 120;
const MAX_REQUEST_ROUNDS = 2;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_JITTER_MS = 500;
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

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

function overpassFootwayQuery(bounds: BoundingBox): string {
  return `
[out:json][timeout:25];
(
  way["highway"]
    ["highway"!~"${WALKABLE_HIGHWAY_EXCLUDE_REGEX}"]
    ["area"!="yes"]
    ["indoor"!="yes"]
    ["access"!~"private|no"]
    ["foot"!~"no"]
    (${bounds.south},${bounds.west},${bounds.north},${bounds.east});
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
    element.nodes.every((nodeId) => typeof nodeId === 'number' && Number.isFinite(nodeId)) &&
    (element.tags === undefined ||
      (typeof element.tags === 'object' &&
        element.tags !== null &&
        Object.values(element.tags).every((tag) => typeof tag === 'string')))
  );
}

export function parseOverpassResponse(payload: unknown): OverpassResponse | null {
  if (!payload || typeof payload !== 'object') return null;
  const response = payload as Partial<OverpassResponse>;
  if (!Array.isArray(response.elements)) return null;

  const elements = response.elements.filter(
    (element) => isNodeElement(element) || isWayElement(element),
  );
  if (elements.length !== response.elements.length) return null;
  return { elements };
}

class OverpassRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
  }
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get('Retry-After');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(signal?.reason);
    };
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchFromEndpoint(
  endpoint: string,
  query: string,
  signal?: AbortSignal,
): Promise<OverpassResponse> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  // Public Overpass instances require identifiable non-browser clients. Browsers
  // supply their own User-Agent and Referer headers, which scripts cannot replace.
  if (typeof window === 'undefined') {
    headers['User-Agent'] =
      'ka-laufweite walkshed builder (https://github.com/maxliesegang/ka-laufweite)';
    headers.Referer = 'https://maxliesegang.github.io/ka-laufweite/';
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: `data=${encodeURIComponent(query)}`,
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  });

  if (!response.ok) {
    throw new OverpassRequestError(
      `Overpass status ${response.status}`,
      response.status,
      retryAfterMs(response),
    );
  }

  const payload: unknown = await response.json();
  const parsed = parseOverpassResponse(payload);
  if (!parsed) {
    throw new Error('Invalid Overpass payload');
  }

  return parsed;
}

export type FootwayNetworkFetchResult =
  { status: 'ok'; networkData: OverpassResponse } | { status: 'all-endpoints-failed' };

/**
 * Fetch every walkable OSM way (and its nodes) inside `bounds` in one request.
 * Endpoint scoring, retries, CORS handling, timeouts, and abort support are all
 * shared by bounded and single-stop requests; only the query geometry differs.
 */
export async function fetchFootwayNetworkInBounds(
  bounds: BoundingBox,
  signal?: AbortSignal,
): Promise<FootwayNetworkFetchResult> {
  loadPreferredEndpointFromStorage();
  const query = overpassFootwayQuery(bounds);
  const orderedEndpoints = orderedEndpointUrls();

  for (let round = 0; round < MAX_REQUEST_ROUNDS; round += 1) {
    let retryDelayMs = RETRY_BASE_DELAY_MS * 2 ** round;
    let retryableFailure = false;

    for (const endpointUrl of orderedEndpoints) {
      if (signal?.aborted) throw signal.reason;
      const startedAt = Date.now();
      try {
        const networkData = await fetchFromEndpoint(endpointUrl, query, signal);
        const durationMs = Date.now() - startedAt;
        markEndpointSuccess(endpointUrl, durationMs);
        return { status: 'ok', networkData };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        markEndpointFailure(endpointUrl);
        if (error instanceof OverpassRequestError) {
          if (!RETRYABLE_STATUS_CODES.has(error.status)) return { status: 'all-endpoints-failed' };
          retryDelayMs = Math.max(retryDelayMs, error.retryAfterMs ?? 0);
        }
        retryableFailure = true;
      }
    }

    if (!retryableFailure || round === MAX_REQUEST_ROUNDS - 1) break;
    await abortableDelay(retryDelayMs + Math.random() * RETRY_JITTER_MS, signal);
  }

  return { status: 'all-endpoints-failed' };
}

export async function fetchFootwayNetwork(
  lat: number,
  lon: number,
  radiusMeters: number,
  signal?: AbortSignal,
): Promise<FootwayNetworkFetchResult> {
  return fetchFootwayNetworkInBounds(boundingBoxForStop(lat, lon, radiusMeters), signal);
}
