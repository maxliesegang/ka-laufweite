import type { LatLng } from './walkshed/types';
import {
  getStorageItem,
  removeStorageItem,
  readStorageJson,
  setStorageItem,
  writeStorageJson,
} from './storage';

interface CacheEntry {
  polygon: LatLng[];
  updatedAt: number;
}

type CacheStore = Record<string, CacheEntry>;

export const WALKSHED_CACHE_STORAGE_KEY = 'karlsruhe-opnv-walkshed-cache-v5';
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
  const parsed = readStorageJson(WALKSHED_CACHE_STORAGE_KEY);
  if (!parsed || typeof parsed !== 'object') return {};

  const entriesRaw = (parsed as { entries?: unknown }).entries;
  if (!entriesRaw || typeof entriesRaw !== 'object') return {};

  const entries: CacheStore = {};
  for (const [key, value] of Object.entries(entriesRaw)) {
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
}

function writeStore(entries: CacheStore): void {
  writeStorageJson(WALKSHED_CACHE_STORAGE_KEY, { entries });
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
  return getStorageItem(WALKSHED_CACHE_RESET_MARKER_KEY) ?? '';
}

export function clearWalkshedCache(): void {
  removeStorageItem(WALKSHED_CACHE_STORAGE_KEY);
  setStorageItem(WALKSHED_CACHE_RESET_MARKER_KEY, String(Date.now()));
}
