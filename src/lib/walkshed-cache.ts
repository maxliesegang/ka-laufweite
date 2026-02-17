import { getStorageItem, setStorageItem } from './storage';
import {
  createWalkshedCachePersistence,
  type CacheEntry,
  type CacheStore,
  type PolygonCacheEntry,
  type UnavailableCacheEntry,
} from './walkshed-cache-persistence';
import type { LatLng } from './walkshed/types';

export const WALKSHED_CACHE_STORAGE_KEY = 'karlsruhe-opnv-walkshed-cache-v5';
export const WALKSHED_CACHE_RESET_MARKER_KEY = 'karlsruhe-opnv-walkshed-cache-reset-marker';

const WALKSHED_CACHE_DB_NAME = 'karlsruhe-opnv-walkshed-cache-v1';
const WALKSHED_CACHE_DB_VERSION = 1;
const WALKSHED_CACHE_DB_STORE_NAME = 'entries';

const MAX_ENTRIES = 4_000;
const MAX_UNAVAILABLE_ENTRIES = 1_000;
const MAX_ENTRY_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

const persistence = createWalkshedCachePersistence({
  dbName: WALKSHED_CACHE_DB_NAME,
  dbVersion: WALKSHED_CACHE_DB_VERSION,
  dbStoreName: WALKSHED_CACHE_DB_STORE_NAME,
  legacyStorageKey: WALKSHED_CACHE_STORAGE_KEY,
});

let cachedStore: CacheStore | null = null;
let loadStorePromise: Promise<CacheStore> | null = null;
let cachedResetMarker: string | null = null;

function currentResetMarker(): string {
  return getStorageItem(WALKSHED_CACHE_RESET_MARKER_KEY) ?? '';
}

function isEntryFresh(updatedAt: number, now = Date.now()): boolean {
  return now - updatedAt <= MAX_ENTRY_AGE_MS;
}

function pruneEntries(entries: CacheStore): CacheStore {
  const now = Date.now();
  const polygons: [string, PolygonCacheEntry][] = [];
  const unavailable: [string, UnavailableCacheEntry][] = [];

  for (const entry of Object.entries(entries)) {
    if (!isEntryFresh(entry[1].updatedAt, now)) continue;
    if (entry[1].kind === 'polygon') {
      polygons.push(entry as [string, PolygonCacheEntry]);
      continue;
    }

    unavailable.push(entry as [string, UnavailableCacheEntry]);
  }

  polygons.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  const limitedPolygons = polygons.slice(0, MAX_ENTRIES);
  if (limitedPolygons.length >= MAX_ENTRIES) {
    return Object.fromEntries(limitedPolygons);
  }

  unavailable.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  const remainingSlots = MAX_ENTRIES - limitedPolygons.length;
  const unavailableSlots = Math.min(remainingSlots, MAX_UNAVAILABLE_ENTRIES);
  return Object.fromEntries([...limitedPolygons, ...unavailable.slice(0, unavailableSlots)]);
}

function pruneEntriesWithRemovedKeys(entries: CacheStore): {
  pruned: CacheStore;
  removedKeys: string[];
} {
  const pruned = pruneEntries(entries);
  const removedKeys = Object.keys(entries).filter((key) => !(key in pruned));
  return { pruned, removedKeys };
}

async function loadStoreFromPersistence(): Promise<CacheStore> {
  const dbEntries = await persistence.readIndexedDbStore();
  if (dbEntries) {
    // IndexedDB is the canonical backend; discard any legacy localStorage snapshot.
    persistence.removeLegacyStore();
    return pruneEntries(dbEntries);
  }

  return pruneEntries(persistence.readLegacyStore());
}

async function ensureStore(): Promise<CacheStore> {
  const marker = currentResetMarker();
  if (cachedStore && cachedResetMarker === marker) return cachedStore;
  if (loadStorePromise && cachedResetMarker === marker) return loadStorePromise;

  cachedResetMarker = marker;
  loadStorePromise = loadStoreFromPersistence()
    .then((entries) => {
      cachedStore = entries;
      return entries;
    })
    .finally(() => {
      loadStorePromise = null;
    });

  return loadStorePromise;
}

async function persistUpsert(cacheKey: string, entries: CacheStore): Promise<void> {
  const entry = entries[cacheKey];
  if (!entry) return;

  if (await persistence.upsertIndexedDbEntry(cacheKey, entry)) return;
  persistence.writeLegacyStore(entries);
}

async function persistRemovals(removedKeys: string[], entries: CacheStore): Promise<void> {
  if (removedKeys.length === 0) return;
  if (await persistence.deleteIndexedDbEntries(removedKeys)) return;
  persistence.writeLegacyStore(entries);
}

async function persistClear(entries: CacheStore): Promise<void> {
  if (await persistence.clearIndexedDbStore()) {
    persistence.removeLegacyStore();
    return;
  }

  persistence.writeLegacyStore(entries);
}

function touchResetMarker(): void {
  const marker = String(Date.now());
  setStorageItem(WALKSHED_CACHE_RESET_MARKER_KEY, marker);
  cachedResetMarker = marker;
}

async function getCacheEntry(cacheKey: string): Promise<CacheEntry | null> {
  const entries = await ensureStore();
  const entry = entries[cacheKey];
  if (!entry) return null;

  if (entry.kind === 'unavailable' && entry.retryAfter <= Date.now()) {
    const nextEntries = { ...entries };
    delete nextEntries[cacheKey];
    cachedStore = nextEntries;
    await persistRemovals([cacheKey], nextEntries);
    return null;
  }

  return entry;
}

async function upsertCacheEntry(cacheKey: string, entry: CacheEntry): Promise<void> {
  const entries = await ensureStore();
  const nextEntries = { ...entries, [cacheKey]: entry };
  const { pruned, removedKeys } = pruneEntriesWithRemovedKeys(nextEntries);
  cachedStore = pruned;

  await persistUpsert(cacheKey, pruned);
  await persistRemovals(
    removedKeys.filter((key) => key !== cacheKey),
    pruned,
  );
}

export async function getCachedWalkshedPolygon(cacheKey: string): Promise<LatLng[] | null> {
  const entry = await getCacheEntry(cacheKey);
  if (!entry || entry.kind !== 'polygon') return null;
  return entry.polygon;
}

export async function setCachedWalkshedPolygon(cacheKey: string, polygon: LatLng[]): Promise<void> {
  await upsertCacheEntry(cacheKey, {
    kind: 'polygon',
    polygon,
    updatedAt: Date.now(),
  });
}

export async function isWalkshedTemporarilyUnavailable(cacheKey: string): Promise<boolean> {
  const entry = await getCacheEntry(cacheKey);
  return entry?.kind === 'unavailable';
}

export async function setCachedWalkshedUnavailable(
  cacheKey: string,
  retryAfterMs: number,
): Promise<void> {
  const boundedRetryAfterMs = Math.max(1_000, Math.round(retryAfterMs));
  const now = Date.now();
  await upsertCacheEntry(cacheKey, {
    kind: 'unavailable',
    retryAfter: now + boundedRetryAfterMs,
    updatedAt: now,
  });
}

export async function getWalkshedCacheSize(): Promise<number> {
  const entries = await ensureStore();
  return Object.values(entries).reduce(
    (count, entry) => count + (entry.kind === 'polygon' ? 1 : 0),
    0,
  );
}

export function getWalkshedCacheResetMarker(): string {
  return getStorageItem(WALKSHED_CACHE_RESET_MARKER_KEY) ?? '';
}

export function reloadCacheIfExternallyReset(): void {
  const marker = currentResetMarker();
  if (marker === cachedResetMarker) return;

  cachedStore = null;
  loadStorePromise = null;
  cachedResetMarker = marker;
}

export async function removeCachedWalkshedPolygonsForStop(stopId: string): Promise<number> {
  return removeCachedWalkshedPolygonsForStops([stopId]);
}

export async function removeCachedWalkshedPolygonsForStops(
  stopIds: Iterable<string>,
): Promise<number> {
  const prefixes = new Set(
    [...stopIds]
      .map((stopId) => stopId.trim())
      .filter((stopId) => stopId.length > 0)
      .map((stopId) => `${stopId}:`),
  );
  if (prefixes.size === 0) return 0;
  const prefixList = [...prefixes];

  const entries = await ensureStore();
  const nextEntries: CacheStore = {};
  const removedKeys: string[] = [];

  for (const [key, entry] of Object.entries(entries)) {
    let shouldRemove = false;
    for (const prefix of prefixList) {
      if (!key.startsWith(prefix)) continue;
      shouldRemove = true;
      break;
    }

    if (shouldRemove) {
      removedKeys.push(key);
      continue;
    }

    nextEntries[key] = entry;
  }

  if (removedKeys.length === 0) return 0;

  cachedStore = nextEntries;
  await persistRemovals(removedKeys, nextEntries);
  touchResetMarker();
  return removedKeys.length;
}

export async function clearWalkshedCache(): Promise<void> {
  const emptyStore: CacheStore = {};
  cachedStore = emptyStore;
  loadStorePromise = null;
  await persistClear(emptyStore);
  touchResetMarker();
}
