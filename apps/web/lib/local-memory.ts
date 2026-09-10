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
export const RECENT_PLACE_LIMIT = 5;

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
