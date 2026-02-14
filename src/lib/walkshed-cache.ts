import type { LatLng } from './walkshed/types';

interface CacheEntry {
  polygon: LatLng[];
  updatedAt: number;
}

type CacheStore = Record<string, CacheEntry>;

export const WALKSHED_CACHE_STORAGE_KEY = 'karlsruhe-opnv-walkshed-cache-v3';
export const WALKSHED_CACHE_RESET_MARKER_KEY = 'karlsruhe-opnv-walkshed-cache-reset-marker';
const MAX_ENTRIES = 400;

function isLatLng(value: unknown): value is LatLng {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1])
  );
}

function readStore(): CacheStore {
  try {
    const raw = localStorage.getItem(WALKSHED_CACHE_STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw);
    if (!parsed?.entries || typeof parsed.entries !== 'object') return {};

    const entries: CacheStore = {};
    for (const [key, value] of Object.entries(parsed.entries)) {
      const entry = value as Partial<CacheEntry>;
      if (
        Array.isArray(entry?.polygon) &&
        entry.polygon.every(isLatLng) &&
        typeof entry.updatedAt === 'number' &&
        Number.isFinite(entry.updatedAt)
      ) {
        entries[key] = { polygon: entry.polygon, updatedAt: entry.updatedAt };
      }
    }

    return entries;
  } catch {
    return {};
  }
}

function writeStore(entries: CacheStore): void {
  localStorage.setItem(WALKSHED_CACHE_STORAGE_KEY, JSON.stringify({ entries }));
}

function pruneEntries(entries: CacheStore): CacheStore {
  const all = Object.entries(entries);
  if (all.length <= MAX_ENTRIES) return entries;

  all.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(all.slice(0, MAX_ENTRIES));
}

export function getCachedWalkshedPolygon(cacheKey: string): LatLng[] | null {
  return readStore()[cacheKey]?.polygon ?? null;
}

export function setCachedWalkshedPolygon(cacheKey: string, polygon: LatLng[]): void {
  const entries = readStore();
  entries[cacheKey] = { polygon, updatedAt: Date.now() };
  writeStore(pruneEntries(entries));
}

export function getWalkshedCacheSize(): number {
  return Object.keys(readStore()).length;
}

export function getWalkshedCacheResetMarker(): string {
  return localStorage.getItem(WALKSHED_CACHE_RESET_MARKER_KEY) ?? '';
}

export function clearWalkshedCache(): void {
  localStorage.removeItem(WALKSHED_CACHE_STORAGE_KEY);
  localStorage.setItem(WALKSHED_CACHE_RESET_MARKER_KEY, String(Date.now()));
}
