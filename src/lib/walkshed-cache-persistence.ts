import { removeStorageItem, readStorageJson, writeStorageJson } from './storage';
import type { LatLng } from './walkshed/types';

export interface PolygonCacheEntry {
  kind: 'polygon';
  polygon: LatLng[];
  updatedAt: number;
}

export interface UnavailableCacheEntry {
  kind: 'unavailable';
  retryAfter: number;
  updatedAt: number;
}

export type CacheEntry = PolygonCacheEntry | UnavailableCacheEntry;
export type CacheStore = Record<string, CacheEntry>;

interface PersistedCacheEntry {
  key: string;
  kind: CacheEntry['kind'];
  polygon?: LatLng[];
  retryAfter?: number;
  updatedAt: number;
}

interface PersistenceOptions {
  dbName: string;
  dbVersion: number;
  dbStoreName: string;
  legacyStorageKey: string;
}

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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseCacheEntry(value: unknown): CacheEntry | null {
  if (!value || typeof value !== 'object') return null;

  const entry = value as Partial<{
    kind: unknown;
    polygon: unknown;
    retryAfter: unknown;
    updatedAt: unknown;
  }>;

  if (
    Array.isArray(entry.polygon) &&
    entry.polygon.every(isLatLng) &&
    isFiniteNumber(entry.updatedAt)
  ) {
    return {
      kind: 'polygon',
      polygon: entry.polygon,
      updatedAt: entry.updatedAt,
    };
  }

  if (
    entry.kind === 'unavailable' &&
    isFiniteNumber(entry.retryAfter) &&
    isFiniteNumber(entry.updatedAt)
  ) {
    return {
      kind: 'unavailable',
      retryAfter: entry.retryAfter,
      updatedAt: entry.updatedAt,
    };
  }

  return null;
}

function parsePersistedCacheEntry(value: unknown): { key: string; entry: CacheEntry } | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<PersistedCacheEntry>;
  if (typeof raw.key !== 'string' || raw.key.length === 0) return null;

  const entry = parseCacheEntry(raw);
  if (!entry) return null;
  return { key: raw.key, entry };
}

function toPersistedCacheEntry(key: string, entry: CacheEntry): PersistedCacheEntry {
  if (entry.kind === 'polygon') {
    return {
      key,
      kind: 'polygon',
      polygon: entry.polygon,
      updatedAt: entry.updatedAt,
    };
  }

  return {
    key,
    kind: 'unavailable',
    retryAfter: entry.retryAfter,
    updatedAt: entry.updatedAt,
  };
}

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionAsPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

export class WalkshedCachePersistence {
  private readonly dbName: string;
  private readonly dbVersion: number;
  private readonly dbStoreName: string;
  private readonly legacyStorageKey: string;
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  constructor(options: PersistenceOptions) {
    this.dbName = options.dbName;
    this.dbVersion = options.dbVersion;
    this.dbStoreName = options.dbStoreName;
    this.legacyStorageKey = options.legacyStorageKey;
  }

  readLegacyStore(): CacheStore {
    const parsed = readStorageJson(this.legacyStorageKey);
    if (!parsed || typeof parsed !== 'object') return {};

    const entriesRaw = (parsed as { entries?: unknown }).entries;
    if (!entriesRaw || typeof entriesRaw !== 'object') return {};

    const entries: CacheStore = {};
    for (const [key, value] of Object.entries(entriesRaw)) {
      const entry = parseCacheEntry(value);
      if (!entry) continue;
      entries[key] = entry;
    }

    return entries;
  }

  writeLegacyStore(entries: CacheStore): void {
    if (Object.keys(entries).length === 0) {
      this.removeLegacyStore();
      return;
    }

    writeStorageJson(this.legacyStorageKey, { entries });
  }

  removeLegacyStore(): void {
    removeStorageItem(this.legacyStorageKey);
  }

  async readIndexedDbStore(): Promise<CacheStore | null> {
    const db = await this.openDatabase();
    if (!db) return null;

    try {
      const transaction = db.transaction(this.dbStoreName, 'readonly');
      const store = transaction.objectStore(this.dbStoreName);
      const rawEntries = await requestAsPromise<unknown[]>(store.getAll() as IDBRequest<unknown[]>);
      await transactionAsPromise(transaction);

      const entries: CacheStore = {};
      for (const rawEntry of rawEntries) {
        const parsed = parsePersistedCacheEntry(rawEntry);
        if (!parsed) continue;
        entries[parsed.key] = parsed.entry;
      }

      return entries;
    } catch {
      return null;
    }
  }

  async upsertIndexedDbEntry(cacheKey: string, entry: CacheEntry): Promise<boolean> {
    const db = await this.openDatabase();
    if (!db) return false;

    try {
      const transaction = db.transaction(this.dbStoreName, 'readwrite');
      transaction.objectStore(this.dbStoreName).put(toPersistedCacheEntry(cacheKey, entry));
      await transactionAsPromise(transaction);
      return true;
    } catch {
      return false;
    }
  }

  async deleteIndexedDbEntries(cacheKeys: Iterable<string>): Promise<boolean> {
    const keys = [...new Set([...cacheKeys].filter((cacheKey) => cacheKey.length > 0))];
    if (keys.length === 0) return true;

    const db = await this.openDatabase();
    if (!db) return false;

    try {
      const transaction = db.transaction(this.dbStoreName, 'readwrite');
      const store = transaction.objectStore(this.dbStoreName);
      for (const key of keys) {
        store.delete(key);
      }
      await transactionAsPromise(transaction);
      return true;
    } catch {
      return false;
    }
  }

  async clearIndexedDbStore(): Promise<boolean> {
    const db = await this.openDatabase();
    if (!db) return false;

    try {
      const transaction = db.transaction(this.dbStoreName, 'readwrite');
      transaction.objectStore(this.dbStoreName).clear();
      await transactionAsPromise(transaction);
      return true;
    } catch {
      return false;
    }
  }

  private async openDatabase(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return null;
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.dbStoreName)) {
          db.createObjectStore(this.dbStoreName, { keyPath: 'key' });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = () => {
        this.dbPromise = null;
        resolve(null);
      };

      request.onblocked = () => {
        this.dbPromise = null;
        resolve(null);
      };
    });

    return this.dbPromise;
  }
}

export function createWalkshedCachePersistence(
  options: PersistenceOptions,
): WalkshedCachePersistence {
  return new WalkshedCachePersistence(options);
}
