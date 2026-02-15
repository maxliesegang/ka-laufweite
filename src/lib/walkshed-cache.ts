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
const PERSIST_DEBOUNCE_MS = 2_000;
const EMPTY_CACHE_STORE: CacheStore = {};

let cachedStore: CacheStore | null = null;
let cachedResetMarker: string | null = null;
let persistTimerId: number | null = null;
let storeDirty = false;

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

function currentResetMarker(): string {
  return getStorageItem(WALKSHED_CACHE_RESET_MARKER_KEY) ?? '';
}

function readStoreFromStorage(): CacheStore {
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

function ensureStore(): CacheStore {
  if (cachedStore) return cachedStore;

  cachedStore = readStoreFromStorage();
  cachedResetMarker = currentResetMarker();
  return cachedStore;
}

function reloadStoreIfReset(): CacheStore {
  const marker = currentResetMarker();
  if (cachedStore && cachedResetMarker === marker) {
    return cachedStore;
  }

  cancelPendingPersist();
  storeDirty = false;
  cachedStore = readStoreFromStorage();
  cachedResetMarker = marker;
  return cachedStore;
}

function pruneEntries(entries: CacheStore): CacheStore {
  const all = Object.entries(entries);
  if (all.length <= MAX_ENTRIES) return entries;

  all.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(all.slice(0, MAX_ENTRIES));
}

function cancelPendingPersist(): void {
  if (persistTimerId !== null) {
    clearTimeout(persistTimerId);
    persistTimerId = null;
  }
}

function flushToStorage(): void {
  cancelPendingPersist();
  if (!storeDirty || !cachedStore) return;
  storeDirty = false;

  const normalized = pruneEntries(cachedStore);
  cachedStore = normalized;

  if (Object.keys(normalized).length === 0) {
    removeStorageItem(WALKSHED_CACHE_STORAGE_KEY);
    return;
  }

  writeStorageJson(WALKSHED_CACHE_STORAGE_KEY, { entries: normalized });
}

function schedulePersist(): void {
  if (persistTimerId !== null) return;
  persistTimerId = window.setTimeout(() => {
    persistTimerId = null;
    flushToStorage();
  }, PERSIST_DEBOUNCE_MS);
}

function persistStoreImmediately(entries: CacheStore): void {
  const normalized = pruneEntries(entries);
  cachedStore = normalized;
  storeDirty = false;
  cancelPendingPersist();

  if (Object.keys(normalized).length === 0) {
    removeStorageItem(WALKSHED_CACHE_STORAGE_KEY);
    return;
  }

  writeStorageJson(WALKSHED_CACHE_STORAGE_KEY, { entries: normalized });
}

function touchResetMarker(): void {
  const marker = String(Date.now());
  setStorageItem(WALKSHED_CACHE_RESET_MARKER_KEY, marker);
  cachedResetMarker = marker;
}

export function getCachedWalkshedPolygon(cacheKey: string): LatLng[] | null {
  return ensureStore()[cacheKey]?.polygon ?? null;
}

export function setCachedWalkshedPolygon(cacheKey: string, polygon: LatLng[]): void {
  const entries = ensureStore();
  entries[cacheKey] = { polygon, updatedAt: Date.now() };
  storeDirty = true;
  schedulePersist();
}

export function getWalkshedCacheSize(): number {
  return Object.keys(ensureStore()).length;
}

export function getWalkshedCacheResetMarker(): string {
  return getStorageItem(WALKSHED_CACHE_RESET_MARKER_KEY) ?? '';
}

export function reloadCacheIfExternallyReset(): void {
  reloadStoreIfReset();
}

export function removeCachedWalkshedPolygonsForStop(stopId: string): number {
  return removeCachedWalkshedPolygonsForStops([stopId]);
}

export function removeCachedWalkshedPolygonsForStops(stopIds: Iterable<string>): number {
  const prefixes = new Set(
    [...stopIds]
      .map((stopId) => stopId.trim())
      .filter((stopId) => stopId.length > 0)
      .map((stopId) => `${stopId}:`),
  );
  if (prefixes.size === 0) return 0;

  const entries = { ...ensureStore() };
  let removed = 0;

  for (const key of Object.keys(entries)) {
    for (const prefix of prefixes) {
      if (!key.startsWith(prefix)) continue;
      delete entries[key];
      removed += 1;
      break;
    }
  }

  if (removed === 0) return 0;

  persistStoreImmediately(entries);
  touchResetMarker();
  return removed;
}

export function clearWalkshedCache(): void {
  cancelPendingPersist();
  storeDirty = false;
  cachedStore = EMPTY_CACHE_STORE;
  removeStorageItem(WALKSHED_CACHE_STORAGE_KEY);
  touchResetMarker();
}
