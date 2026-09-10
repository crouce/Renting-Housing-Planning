export type RememberedPlace = {
  id: string;
  name: string;
  district: string;
  adcode: string;
  location: string;
  address: string;
  typecode: string;
};

export type RememberedPreferences = {
  selectedPlace: RememberedPlace | null;
  budget: number;
  departureDate: string;
  departureTime: string;
  stationRadius: 500 | 1000 | 1500;
};

type PlannerMemory = {
  version: 1;
  updatedAt: number;
  preferences: RememberedPreferences;
  recentPlaces: RememberedPlace[];
};

const MEMORY_KEY = 'commute-radius:planner-memory:v1';
const MEMORY_ENABLED_KEY = 'commute-radius:memory-enabled';
const CACHE_DATABASE = 'commute-radius-local-memory';
const CACHE_DATABASE_VERSION = 1;
const STATION_STORE = 'station-cache';
const COMMUTE_STORE = 'commute-cache';
export const RECENT_PLACE_LIMIT = 5;
export const STATION_CACHE_LIMIT = 6;
export const STATION_CACHE_FRESH_MS = 24 * 60 * 60 * 1000;
export const CACHE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type LocalCacheRecord<T> = {
  key: string;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number;
  discardAfter: number;
  data: T;
};

function storageAvailable() {
  return typeof window !== 'undefined' && Boolean(window.localStorage);
}

export function isLocalMemoryEnabled() {
  if (!storageAvailable()) return true;
  return window.localStorage.getItem(MEMORY_ENABLED_KEY) !== 'false';
}

export function setLocalMemoryEnabled(enabled: boolean) {
  if (!storageAvailable()) return;
  window.localStorage.setItem(MEMORY_ENABLED_KEY, String(enabled));
}

export function readPlannerMemory(): PlannerMemory | null {
  if (!storageAvailable() || !isLocalMemoryEnabled()) return null;
  try {
    const raw = window.localStorage.getItem(MEMORY_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as PlannerMemory;
    if (value.version !== 1 || !value.preferences) return null;
    return value;
  } catch {
    window.localStorage.removeItem(MEMORY_KEY);
    return null;
  }
}

export function writePlannerMemory(
  preferences: RememberedPreferences,
  recentPlaces: RememberedPlace[],
) {
  if (!storageAvailable() || !isLocalMemoryEnabled()) return;
  const memory: PlannerMemory = {
    version: 1,
    updatedAt: Date.now(),
    preferences,
    recentPlaces: recentPlaces.slice(0, RECENT_PLACE_LIMIT),
  };
  try {
    window.localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // A private browsing profile may deny even this small optional record.
  }
}

export function addRecentPlace(
  recentPlaces: RememberedPlace[],
  place: RememberedPlace,
) {
  return [
    place,
    ...recentPlaces.filter(
      (item) => item.id !== place.id && item.location !== place.location,
    ),
  ].slice(0, RECENT_PLACE_LIMIT);
}

export function clearPlannerMemory() {
  if (!storageAvailable()) return;
  window.localStorage.removeItem(MEMORY_KEY);
}

function openCacheDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = window.indexedDB.open(
      CACHE_DATABASE,
      CACHE_DATABASE_VERSION,
    );
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const storeName of [STATION_STORE, COMMUTE_STORE]) {
        if (!database.objectStoreNames.contains(storeName)) {
          const store = database.createObjectStore(storeName, {
            keyPath: 'key',
          });
          store.createIndex('lastAccessedAt', 'lastAccessedAt');
          store.createIndex('discardAfter', 'discardAfter');
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function pruneStore(storeName: string, limit: number) {
  const database = await openCacheDatabase();
  try {
    const records = await requestResult(
      database
        .transaction(storeName, 'readonly')
        .objectStore(storeName)
        .getAll(),
    );
    const now = Date.now();
    const removable = (records as LocalCacheRecord<unknown>[])
      .filter((record) => record.discardAfter <= now)
      .map((record) => record.key);
    const retained = (records as LocalCacheRecord<unknown>[])
      .filter((record) => record.discardAfter > now)
      .sort((left, right) => right.lastAccessedAt - left.lastAccessedAt);
    removable.push(...retained.slice(limit).map((record) => record.key));
    if (removable.length === 0) return;
    const transaction = database.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    for (const key of removable) store.delete(key);
  } finally {
    database.close();
  }
}

async function readCache<T>(storeName: string, key: string) {
  if (!isLocalMemoryEnabled()) return null;
  try {
    const database = await openCacheDatabase();
    try {
      const transaction = database.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const record = (await requestResult(
        store.get(key),
      )) as LocalCacheRecord<T> | null;
      if (!record) return null;
      if (record.discardAfter <= Date.now()) {
        store.delete(key);
        return null;
      }
      record.lastAccessedAt = Date.now();
      store.put(record);
      return record;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

async function writeCache<T>(
  storeName: string,
  key: string,
  data: T,
  freshForMs: number,
  limit: number,
) {
  if (!isLocalMemoryEnabled()) return;
  try {
    const database = await openCacheDatabase();
    const now = Date.now();
    try {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put({
        key,
        createdAt: now,
        lastAccessedAt: now,
        expiresAt: now + freshForMs,
        discardAfter: now + CACHE_RETENTION_MS,
        data,
      } satisfies LocalCacheRecord<T>);
    } finally {
      database.close();
    }
    await pruneStore(storeName, limit);
  } catch {
    // Cache writes are an optimization and must not block the planner.
  }
}

export function readStationCache<T>(key: string) {
  return readCache<T>(STATION_STORE, key);
}

export function writeStationCache<T>(key: string, data: T) {
  return writeCache(
    STATION_STORE,
    key,
    data,
    STATION_CACHE_FRESH_MS,
    STATION_CACHE_LIMIT,
  );
}

export async function clearAllLocalMemory() {
  clearPlannerMemory();
  if (typeof window === 'undefined' || !window.indexedDB) return;
  await new Promise<void>((resolve) => {
    const request = window.indexedDB.deleteDatabase(CACHE_DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
