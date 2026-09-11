'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Building2,
  BusFront,
  CalendarDays,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  Database,
  History,
  LocateFixed,
  MapPin,
  Radar,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  TrainFront,
  Trophy,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import {
  addRecentPlace,
  clearAllLocalMemory,
  isLocalMemoryEnabled,
  readCommuteCache,
  readPlannerMemory,
  readStationCache,
  setLocalMemoryEnabled,
  updateCommuteCache,
  writeCommuteCache,
  writePlannerMemory,
  writeStationCache,
} from '@/lib/local-memory';

type PlaceTip = {
  id: string;
  name: string;
  district: string;
  adcode: string;
  location: string;
  address: string;
  typecode: string;
};

type Station = {
  id: string;
  name: string;
  location: string;
  distanceMeters: number;
  mode: 'BUS' | 'SUBWAY' | 'LIGHT_RAIL';
  address: string;
  lines: string[];
  citycode: string;
  adcode: string;
};

type ReachableStation = Station & {
  logicalId: string;
  transitDurationSeconds: number;
  transitDurationMinutes: number;
  durationSeconds: number;
  durationMinutes: number;
  straightLineMeters: number;
  segmentCount: number;
  routeLines: string[];
  matchedLines: string[];
  routeGeometry: RouteGeometrySegment[];
  accessStation: {
    id: string;
    name: string;
    walkingDistanceMeters: number;
    walkingMinutes: number;
    remainingTransitSeconds: number;
    remainingTransitMinutes: number;
  };
};

type RouteGeometrySegment = {
  mode: 'WALK' | 'TRANSIT';
  path: Array<[number, number]>;
  lineId?: string;
  lineName?: string;
  transitMode?: Station['mode'];
  stops: Array<{
    id: string;
    name: string;
    location: [number, number];
    role: 'BOARD' | 'VIA' | 'ALIGHT';
  }>;
};

type DirectionReachability = {
  direction: 'to';
  routeCheckCount: number;
  checkedCount: number;
  failedCount: number;
  reachableCount: number;
  fastestCandidateMinutes: number | null;
  farthest: ReachableStation | null;
  nearMisses: ReachableStation[];
  stations: ReachableStation[];
  accessRoutes: Array<{
    accessStationId: string;
    accessStationName: string;
    reachableCount: number;
    farthestRouteId: string | null;
    routeIds: string[];
  }>;
};

type ReachabilityResult = {
  sampled: true;
  candidateSource: 'transit_lines';
  budgetMinutes: number;
  networkSpanMeters: number;
  candidateCount: number;
  lineQueryCount: number;
  expandedLineCount: number;
  routeCheckCount: number;
  selectedAccessStationCount: number;
  accessStationBudgets: Array<{
    id: string;
    name: string;
    walkingDistanceMeters: number;
    walkingMinutes: number;
    remainingTransitMinutes: number;
    usable: boolean;
  }>;
  directions: {
    to: DirectionReachability;
  };
  cached?: boolean;
};

type RememberedCommuteResult = {
  result: ReachabilityResult;
  activeRouteId: string | null;
};

type AMapOverlay = { setMap(map: AMapMap | null): void };
type AMapMarker = AMapOverlay;
type AMapMap = {
  setCenter(position: [number, number]): void;
  setZoom(zoom: number): void;
  setFitView(
    overlays?: AMapOverlay[],
    immediately?: boolean,
    avoid?: number[],
  ): void;
  destroy(): void;
};
type AMapNamespace = {
  Map: new (
    container: HTMLElement,
    options: Record<string, unknown>,
  ) => AMapMap;
  Marker: new (options: Record<string, unknown>) => AMapMarker;
  Polyline: new (options: Record<string, unknown>) => AMapOverlay;
};

type ModelContext = {
  registerTool(
    tool: {
      name: string;
      title?: string;
      description: string;
      inputSchema: object;
      annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
      execute(input: unknown): unknown;
    },
    options?: { signal?: AbortSignal },
  ): void | Promise<void>;
};

declare global {
  interface Window {
    AMap?: AMapNamespace;
    _AMapSecurityConfig?: { securityJsCode: string };
  }

  interface Document {
    readonly modelContext?: ModelContext;
  }
}

const DEFAULT_CENTER: [number, number] = [121.4737, 31.2304];
const ROUTE_PALETTE = ['#126b55', '#167c96', '#315fa8', '#6250a8'] as const;
const WALKING_ROUTE_COLOR = '#6f7f79';

function displayLineName(lineName?: string) {
  return lineName?.split('(')[0].trim() || '公共交通';
}

function routeVisuals(station?: ReachableStation | null) {
  const lineColors = new Map<string, string>();
  return (station?.routeGeometry ?? []).map((segment, index) => {
    if (segment.mode === 'WALK') {
      return {
        segment,
        color: WALKING_ROUTE_COLOR,
        lineKey: `walk:${index}`,
        lineLabel: '换乘步行',
      };
    }
    const lineKey = segment.lineId ?? segment.lineName ?? `line:${index}`;
    if (!lineColors.has(lineKey)) {
      lineColors.set(
        lineKey,
        ROUTE_PALETTE[lineColors.size % ROUTE_PALETTE.length],
      );
    }
    return {
      segment,
      color: lineColors.get(lineKey)!,
      lineKey,
      lineLabel: displayLineName(segment.lineName),
    };
  });
}

function parseLocation(location: string): [number, number] {
  const [longitude, latitude] = location.split(',').map(Number);
  return [longitude, latitude];
}

function tomorrowAsInputValue() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

function stationMemoryKey(place: PlaceTip, radius: number) {
  return `stations:v2:${place.location}:${radius}`;
}

function commuteMemoryKey(
  place: PlaceTip,
  budget: number,
  departureDate: string,
  departureTime: string,
  selectedStationIds: string[],
  selectedLineKeys: string[],
) {
  return [
    'commute:v5',
    place.location,
    budget,
    departureDate,
    departureTime,
    [...selectedStationIds].sort().join(','),
    [...selectedLineKeys].sort().join(','),
  ].join('|');
}

function memoryAgeLabel(savedAt: number) {
  const elapsedMinutes = Math.max(
    0,
    Math.floor((Date.now() - savedAt) / 60_000),
  );
  if (elapsedMinutes < 1) return '刚刚';
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} 小时前`;
  return `${Math.floor(elapsedHours / 24)} 天前`;
}

function availableStationChoices(
  nearbyStations: Station[],
  stationIds: string[],
  lineKeys: string[],
) {
  const availableIds = new Set(nearbyStations.map((station) => station.id));
  const selectedIds = stationIds
    .filter((stationId) => availableIds.has(stationId))
    .slice(0, 3);
  if (selectedIds.length === 0 && nearbyStations[0]) {
    selectedIds.push(nearbyStations[0].id);
  }
  const availableLineKeys = new Set(
    nearbyStations.flatMap((station) =>
      station.lines.map((line) => `${station.id}::${line}`),
    ),
  );
  return {
    stationIds: selectedIds,
    lineKeys: lineKeys.filter(
      (lineKey) =>
        availableLineKeys.has(lineKey) &&
        selectedIds.some((stationId) => lineKey.startsWith(`${stationId}::`)),
    ),
  };
}

function loadAMap(jsKey: string, securityCode: string) {
  if (window.AMap) return Promise.resolve(window.AMap);

  window._AMapSecurityConfig = { securityJsCode: securityCode };
  const existing = document.querySelector<HTMLScriptElement>(
    'script[data-amap-loader="true"]',
  );

  return new Promise<AMapNamespace>((resolve, reject) => {
    const handleLoad = () => {
      if (window.AMap) resolve(window.AMap);
      else reject(new Error('AMap namespace unavailable'));
    };
    const handleError = () => reject(new Error('AMap script failed'));

    if (existing) {
      existing.addEventListener('load', handleLoad, { once: true });
      existing.addEventListener('error', handleError, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.dataset.amapLoader = 'true';
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(jsKey)}`;
    script.async = true;
    script.addEventListener('load', handleLoad, { once: true });
    script.addEventListener('error', handleError, { once: true });
    document.head.appendChild(script);
  });
}

export function CommutePlanner() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<AMapMap | null>(null);
  const amapRef = useRef<AMapNamespace | null>(null);
  const overlaysRef = useRef<AMapOverlay[]>([]);
  const anchorMarkerRef = useRef<AMapMarker | null>(null);
  const restoredSelectionRef = useRef<{
    stationIds: string[];
    lineKeys: string[];
  } | null>(null);
  const skipMemoryWriteRef = useRef(false);
  const [mapState, setMapState] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [query, setQuery] = useState('');
  const [tips, setTips] = useState<PlaceTip[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedPlace, setSelectedPlace] = useState<PlaceTip | null>(null);
  const [stations, setStations] = useState<Station[]>([]);
  const [showAllStations, setShowAllStations] = useState(false);
  const [stationRadius, setStationRadius] = useState<500 | 1000 | 1500>(500);
  const [selectedStationIds, setSelectedStationIds] = useState<string[]>([]);
  const [selectedLineKeys, setSelectedLineKeys] = useState<string[]>([]);
  const [stationState, setStationState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [reachabilityState, setReachabilityState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [reachability, setReachability] = useState<ReachabilityResult | null>(
    null,
  );
  const [activeRouteId, setActiveRouteId] = useState<string | null>(null);
  const [reachabilityError, setReachabilityError] = useState('');
  const [budget, setBudget] = useState(45);
  const [departureDate, setDepartureDate] = useState(tomorrowAsInputValue);
  const [departureTime, setDepartureTime] = useState('08:30');
  const [memoryReady, setMemoryReady] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(true);
  const [memoryClearNonce, setMemoryClearNonce] = useState(0);
  const [rememberLocally, setRememberLocally] = useState(true);
  const [recentPlaces, setRecentPlaces] = useState<PlaceTip[]>([]);
  const [memoryMessage, setMemoryMessage] = useState('');
  const [stationMemory, setStationMemory] = useState<{
    savedAt: number;
    stale: boolean;
  } | null>(null);
  const [commuteMemory, setCommuteMemory] = useState<{
    savedAt: number;
    stale: boolean;
    fallback: boolean;
  } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const enabled = isLocalMemoryEnabled();
      setRememberLocally(enabled);
      const memory = enabled ? readPlannerMemory() : null;
      if (memory) {
        const { preferences } = memory;
        setBudget(preferences.budget);
        setDepartureDate(preferences.departureDate);
        setDepartureTime(preferences.departureTime);
        setStationRadius(preferences.stationRadius);
        setRecentPlaces(memory.recentPlaces);
        restoredSelectionRef.current = {
          stationIds: preferences.selectedStationIds ?? [],
          lineKeys: preferences.selectedLineKeys ?? [],
        };
        if (preferences.selectedPlace) {
          setSelectedPlace(preferences.selectedPlace);
          setQuery(preferences.selectedPlace.name);
          setMemoryMessage('已恢复上次的工作地点和通勤条件');
          setShowOnboarding(false);
        }
      }
      setMemoryReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!memoryReady || !rememberLocally) return;
    if (skipMemoryWriteRef.current) {
      skipMemoryWriteRef.current = false;
      return;
    }
    writePlannerMemory(
      {
        selectedPlace,
        budget,
        departureDate,
        departureTime,
        stationRadius,
        selectedStationIds,
        selectedLineKeys,
      },
      recentPlaces,
    );
  }, [
    budget,
    departureDate,
    departureTime,
    memoryReady,
    memoryClearNonce,
    recentPlaces,
    rememberLocally,
    selectedPlace,
    selectedLineKeys,
    selectedStationIds,
    stationRadius,
  ]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;

    const lifecycle = new AbortController();
    void Promise.resolve(
      context.registerTool(
        {
          name: 'configure_commute_search',
          title: '设置通勤查询',
          description:
            '填写可见的工作地点关键词、住所到公司的通勤时间预算和出发时间。',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', minLength: 2, maxLength: 80 },
              budgetMinutes: { type: 'integer', minimum: 20, maximum: 90 },
              departureDate: { type: 'string', format: 'date' },
              departureTime: {
                type: 'string',
                pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
              },
            },
            required: ['query', 'budgetMinutes'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute(input) {
            const value = input as Record<string, unknown>;
            const nextQuery =
              typeof value.query === 'string' ? value.query.trim() : '';
            const nextBudget = Number(value.budgetMinutes);
            if (
              nextQuery.length < 2 ||
              nextQuery.length > 80 ||
              !Number.isInteger(nextBudget) ||
              nextBudget < 20 ||
              nextBudget > 90
            ) {
              throw new Error('通勤查询参数无效。');
            }

            setSelectedPlace(null);
            setStations([]);
            setSelectedStationIds([]);
            setSelectedLineKeys([]);
            setShowAllStations(false);
            setStationState('idle');
            setReachability(null);
            setReachabilityState('idle');
            overlaysRef.current.forEach((overlay) => overlay.setMap(null));
            overlaysRef.current = [];
            anchorMarkerRef.current = null;
            setQuery(nextQuery);
            setBudget(nextBudget);
            if (typeof value.departureDate === 'string')
              setDepartureDate(value.departureDate);
            if (typeof value.departureTime === 'string')
              setDepartureTime(value.departureTime);

            return {
              query: nextQuery,
              budgetMinutes: nextBudget,
              direction: 'to_work',
              status: 'configured',
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);

    return () => lifecycle.abort();
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function initializeMap() {
      try {
        const response = await fetch('/api/amap/config');
        if (!response.ok) throw new Error('AMap config unavailable');
        const config = (await response.json()) as {
          jsKey: string;
          securityCode: string;
        };
        const AMap = await loadAMap(config.jsKey, config.securityCode);
        if (cancelled || !mapContainerRef.current) return;
        amapRef.current = AMap;
        mapRef.current = new AMap.Map(mapContainerRef.current, {
          center: DEFAULT_CENTER,
          zoom: 11,
          viewMode: '2D',
          resizeEnable: true,
        });
        setMapState('ready');
      } catch {
        if (!cancelled) setMapState('error');
      }
    }

    void initializeMap();
    return () => {
      cancelled = true;
      mapRef.current?.destroy();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const AMap = amapRef.current;
    const map = mapRef.current;
    if (
      mapState !== 'ready' ||
      !selectedPlace ||
      !AMap ||
      !map ||
      anchorMarkerRef.current
    ) {
      return;
    }
    const position = parseLocation(selectedPlace.location);
    const marker = new AMap.Marker({
      map,
      position,
      anchor: 'bottom-center',
      title: selectedPlace.name,
    });
    anchorMarkerRef.current = marker;
    overlaysRef.current.push(marker);
    map.setCenter(position);
    map.setZoom(15);
  }, [mapState, selectedPlace]);

  useEffect(() => {
    if (!memoryReady || !rememberLocally || !selectedPlace) return;
    let cancelled = false;
    const key = stationMemoryKey(selectedPlace, stationRadius);
    void readStationCache<Station[]>(key).then((record) => {
      if (cancelled || !record) return;
      const restored = restoredSelectionRef.current;
      const choices = availableStationChoices(
        record.data,
        restored?.stationIds ?? [],
        restored?.lineKeys ?? [],
      );
      restoredSelectionRef.current = null;
      setStations(record.data);
      setSelectedStationIds(choices.stationIds);
      setSelectedLineKeys(choices.lineKeys);
      setStationState('ready');
      setStationMemory({
        savedAt: record.createdAt,
        stale: record.expiresAt <= Date.now(),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [memoryReady, rememberLocally, selectedPlace, stationRadius]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2 || selectedPlace?.name === trimmed) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const response = await fetch(
          `/api/amap/inputtips?keywords=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error('Search failed');
        const data = (await response.json()) as { tips: PlaceTip[] };
        setTips(data.tips);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError'))
          setTips([]);
      } finally {
        setSearching(false);
      }
    }, 320);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, selectedPlace]);

  const groupedStations = useMemo(
    () => ({
      rail: stations.filter((station) => station.mode !== 'BUS'),
      bus: stations.filter((station) => station.mode === 'BUS'),
    }),
    [stations],
  );

  const clearMapOverlays = useCallback(() => {
    overlaysRef.current.forEach((overlay) => overlay.setMap(null));
    overlaysRef.current = [];
  }, []);

  function resetReachability() {
    setReachability(null);
    setReachabilityState('idle');
    setActiveRouteId(null);
    setReachabilityError('');
    setCommuteMemory(null);
  }

  function resetNearbyStations() {
    setStations([]);
    setShowAllStations(false);
    setStationState('idle');
    setSelectedStationIds([]);
    setSelectedLineKeys([]);
    setStationMemory(null);
    resetReachability();

    const map = mapRef.current;
    clearMapOverlays();
    if (map && anchorMarkerRef.current) {
      anchorMarkerRef.current.setMap(map);
      overlaysRef.current.push(anchorMarkerRef.current);
    }
  }

  function stationLineKey(stationId: string, line: string) {
    return `${stationId}::${line}`;
  }

  function setStationSelected(stationId: string, selected: boolean) {
    setSelectedStationIds((current) => {
      if (selected) {
        if (current.includes(stationId) || current.length >= 3) return current;
        return [...current, stationId];
      }
      return current.filter((id) => id !== stationId);
    });
    if (!selected) {
      setSelectedLineKeys((current) =>
        current.filter((key) => !key.startsWith(`${stationId}::`)),
      );
    }
    resetReachability();
  }

  function toggleStationLine(stationId: string, line: string) {
    const key = stationLineKey(stationId, line);
    setSelectedLineKeys((current) =>
      current.includes(key)
        ? current.filter((value) => value !== key)
        : [...current, key],
    );
    resetReachability();
  }

  function handleQueryChange(nextValue: string) {
    setQuery(nextValue);
    if (nextValue.trim().length < 2) setTips([]);
    if (selectedPlace?.name === nextValue) return;
    setSelectedPlace(null);
    setStations([]);
    setSelectedStationIds([]);
    setSelectedLineKeys([]);
    setShowAllStations(false);
    setStationMemory(null);
    resetReachability();
    clearMapOverlays();
    anchorMarkerRef.current = null;
  }

  function setMemoryPreference(checked: boolean) {
    setRememberLocally(checked);
    setLocalMemoryEnabled(checked);
    if (!checked) {
      void clearAllLocalMemory();
      setRecentPlaces([]);
      setStationMemory(null);
      setCommuteMemory(null);
      setMemoryMessage('本机记忆已关闭并清除');
    } else {
      setMemoryMessage('本机记忆已开启');
    }
  }

  function selectPlace(place: PlaceTip) {
    setSelectedPlace(place);
    setQuery(place.name);
    setTips([]);
    setStations([]);
    setShowAllStations(false);
    setSelectedStationIds([]);
    setSelectedLineKeys([]);
    setStationState('idle');
    setStationMemory(null);
    resetReachability();
    clearMapOverlays();

    if (rememberLocally) {
      setRecentPlaces((current) => addRecentPlace(current, place));
      setMemoryMessage('工作地点已记在本机');
    }

    const AMap = amapRef.current;
    const map = mapRef.current;
    if (!AMap || !map) return;
    const position = parseLocation(place.location);
    const marker = new AMap.Marker({
      map,
      position,
      anchor: 'bottom-center',
      title: place.name,
    });
    anchorMarkerRef.current = marker;
    overlaysRef.current.push(marker);
    map.setCenter(position);
    map.setZoom(15);
  }

  const drawNearbyStations = useCallback(
    (nearbyStations: Station[]) => {
      const AMap = amapRef.current;
      const map = mapRef.current;
      if (!AMap || !map) return;
      clearMapOverlays();
      const anchor = anchorMarkerRef.current;
      if (anchor) {
        anchor.setMap(map);
        overlaysRef.current.push(anchor);
      }

      const markers = nearbyStations.map(
        (station, index) =>
          new AMap.Marker({
            map,
            position: parseLocation(station.location),
            anchor: 'bottom-center',
            title: station.name,
            content: `<span class="station-map-pin ${station.mode === 'BUS' ? 'is-bus' : 'is-rail'}${index < 6 ? ' is-listed' : ''}"><b>${index < 6 ? index + 1 : station.mode === 'BUS' ? '公' : '轨'}</b></span>`,
          }),
      );
      overlaysRef.current.push(...markers);
      map.setFitView(overlaysRef.current, false, [90, 70, 90, 430]);
    },
    [clearMapOverlays],
  );

  useEffect(() => {
    if (mapState === 'ready' && stationState === 'ready') {
      drawNearbyStations(stations);
    }
  }, [drawNearbyStations, mapState, stationState, stations]);

  async function findStations() {
    const place = selectedPlace;
    if (!place) return;
    setStationState('loading');
    resetReachability();
    setShowAllStations(false);
    const cacheKey = stationMemoryKey(place, stationRadius);
    const cached = rememberLocally
      ? await readStationCache<Station[]>(cacheKey)
      : null;

    if (cached && cached.expiresAt > Date.now()) {
      const choices = availableStationChoices(
        cached.data,
        selectedStationIds,
        selectedLineKeys,
      );
      setStations(cached.data);
      setSelectedStationIds(choices.stationIds);
      setSelectedLineKeys(choices.lineKeys);
      setStationState('ready');
      setStationMemory({ savedAt: cached.createdAt, stale: false });
      drawNearbyStations(cached.data);
      return;
    }

    try {
      const response = await fetch(
        `/api/amap/stations?location=${encodeURIComponent(place.location)}&radius=${stationRadius}`,
      );
      if (!response.ok) throw new Error('Station search failed');
      const data = (await response.json()) as { stations: Station[] };
      const choices = availableStationChoices(
        data.stations,
        selectedStationIds,
        selectedLineKeys,
      );
      setStations(data.stations);
      setSelectedStationIds(choices.stationIds);
      setSelectedLineKeys(choices.lineKeys);
      setStationState('ready');
      setStationMemory(
        rememberLocally ? { savedAt: Date.now(), stale: false } : null,
      );
      drawNearbyStations(data.stations);
      if (rememberLocally) {
        void writeStationCache(cacheKey, data.stations);
      }
    } catch {
      if (cached) {
        const choices = availableStationChoices(
          cached.data,
          selectedStationIds,
          selectedLineKeys,
        );
        setStations(cached.data);
        setSelectedStationIds(choices.stationIds);
        setSelectedLineKeys(choices.lineKeys);
        setStationState('ready');
        setStationMemory({ savedAt: cached.createdAt, stale: true });
        drawNearbyStations(cached.data);
      } else {
        setStationState('error');
      }
    }
  }

  const drawReachabilityMap = useCallback(
    (data: ReachabilityResult, activeStation: ReachableStation) => {
      const AMap = amapRef.current;
      const map = mapRef.current;
      if (!AMap || !map) return;

      clearMapOverlays();
      const focusOverlays: AMapOverlay[] = [];
      const anchor = anchorMarkerRef.current;
      if (anchor) {
        anchor.setMap(map);
        overlaysRef.current.push(anchor);
        focusOverlays.push(anchor);
      }

      const routeSegments = routeVisuals(activeStation);
      const representativeRouteIds = new Set(
        (data.directions.to.accessRoutes ?? [])
          .map((accessRoute) => accessRoute.farthestRouteId)
          .filter((routeId): routeId is string => Boolean(routeId)),
      );
      representativeRouteIds.add(activeStation.logicalId);
      const overviewRoutes = data.directions.to.stations
        .filter(
          (station) =>
            representativeRouteIds.has(station.logicalId) &&
            station.routeGeometry.length > 0,
        )
        .sort((left, right) =>
          left.logicalId === activeStation.logicalId
            ? 1
            : right.logicalId === activeStation.logicalId
              ? -1
              : 0,
        );
      const routePolylines = overviewRoutes.flatMap((routeStation) => {
        const isActive = routeStation.logicalId === activeStation.logicalId;
        return routeVisuals(routeStation).map(
          ({ segment, color }) =>
            new AMap.Polyline({
              map,
              path: segment.path,
              zIndex: isActive
                ? segment.mode === 'WALK'
                  ? 49
                  : 52
                : segment.mode === 'WALK'
                  ? 35
                  : 37,
              isOutline: isActive,
              outlineColor: '#ffffff',
              borderWeight: isActive ? 2 : 0,
              strokeColor: color,
              strokeOpacity: isActive
                ? segment.mode === 'WALK'
                  ? 0.82
                  : 1
                : 0.34,
              strokeWeight: isActive
                ? segment.mode === 'WALK'
                  ? 4
                  : 8
                : segment.mode === 'WALK'
                  ? 3
                  : 5,
              strokeStyle: segment.mode === 'WALK' ? 'dashed' : 'solid',
              lineJoin: 'round',
              lineCap: 'round',
            }),
        );
      });
      overlaysRef.current.push(...routePolylines);
      focusOverlays.push(...routePolylines);

      const routeStops = new Map<
        string,
        {
          name: string;
          location: [number, number];
          roles: Set<RouteGeometrySegment['stops'][number]['role']>;
          lines: Map<string, { label: string; color: string }>;
        }
      >();
      for (const visual of routeSegments) {
        if (visual.segment.mode !== 'TRANSIT') continue;
        for (const stop of visual.segment.stops) {
          const key = stop.id || `${stop.name}:${stop.location.join(',')}`;
          const current = routeStops.get(key) ?? {
            name: stop.name,
            location: stop.location,
            roles: new Set(),
            lines: new Map(),
          };
          current.roles.add(stop.role);
          current.lines.set(visual.lineKey, {
            label: visual.lineLabel,
            color: visual.color,
          });
          routeStops.set(key, current);
        }
      }
      const routeStopMarkers = [...routeStops.values()].map((stop) => {
        const content = document.createElement('div');
        content.className = `route-stop-marker${
          stop.roles.has('BOARD') || stop.roles.has('ALIGHT')
            ? ' is-transfer'
            : ''
        }`;
        const dot = document.createElement('i');
        const label = document.createElement('span');
        label.textContent = stop.name;
        const lines = document.createElement('small');
        for (const line of stop.lines.values()) {
          const badge = document.createElement('b');
          badge.textContent = line.label;
          badge.style.setProperty('--route-line-color', line.color);
          lines.appendChild(badge);
        }
        content.appendChild(dot);
        content.appendChild(label);
        content.appendChild(lines);
        return new AMap.Marker({
          map,
          position: stop.location,
          anchor: 'bottom-center',
          zIndex: 92,
          title: `${stop.name} · ${[...stop.lines.values()]
            .map((line) => line.label)
            .join(' / ')}`,
          content,
        });
      });
      overlaysRef.current.push(...routeStopMarkers);
      focusOverlays.push(...routeStopMarkers);

      const startMarkers = stations
        .filter((station) => selectedStationIds.includes(station.id))
        .map(
          (station, index) =>
            new AMap.Marker({
              map,
              position: parseLocation(station.location),
              anchor: 'center',
              zIndex: 120,
              title: `公司侧接驳站：${station.name}`,
              content: `<span class="route-start-marker">司${index + 1}</span>`,
            }),
        );
      overlaysRef.current.push(...startMarkers);
      focusOverlays.push(...startMarkers);

      const candidateMarkers = data.directions.to.stations.map((station) => {
        const isActive = station.logicalId === activeStation.logicalId;
        const isFarthest =
          station.logicalId === data.directions.to.farthest?.logicalId;
        const content = document.createElement('span');
        content.className = `reachable-map-marker ${
          station.mode === 'BUS' ? 'is-bus' : 'is-rail'
        }${isFarthest ? ' is-farthest' : ''}${
          isActive ? ' is-active' : ' is-muted'
        }`;
        const minutes = document.createElement('em');
        minutes.textContent = `${station.durationMinutes}分`;
        content.appendChild(minutes);
        const marker = new AMap.Marker({
          map,
          position: parseLocation(station.location),
          anchor: 'center',
          zIndex: isActive ? 135 : 80,
          title: `${station.name} → ${station.accessStation.name} · ${station.durationMinutes} 分钟`,
          content,
        });
        if (isActive) focusOverlays.push(marker);
        return marker;
      });
      overlaysRef.current.push(...candidateMarkers);
      map.setFitView(focusOverlays, false, [90, 70, 90, 430]);
    },
    [clearMapOverlays, selectedStationIds, stations],
  );

  const applyReachabilityResult = useCallback(
    (
      data: ReachabilityResult,
      preferredRouteId: string | null,
      memory: { savedAt: number; stale: boolean; fallback: boolean } | null,
    ) => {
      setReachability(data);
      setReachabilityState('ready');
      setReachabilityError('');
      setCommuteMemory(memory);
      const initialStation =
        data.directions.to.stations.find(
          (station) => station.logicalId === preferredRouteId,
        ) ??
        data.directions.to.farthest ??
        data.directions.to.stations[0];
      if (initialStation) {
        setActiveRouteId(initialStation.logicalId);
        drawReachabilityMap(data, initialStation);
      }
    },
    [drawReachabilityMap],
  );

  useEffect(() => {
    if (
      !memoryReady ||
      !rememberLocally ||
      !selectedPlace ||
      selectedStationIds.length === 0 ||
      stationState !== 'ready' ||
      reachabilityState !== 'idle'
    ) {
      return;
    }
    let cancelled = false;
    const key = commuteMemoryKey(
      selectedPlace,
      budget,
      departureDate,
      departureTime,
      selectedStationIds,
      selectedLineKeys,
    );
    void readCommuteCache<RememberedCommuteResult>(key).then((record) => {
      if (cancelled || !record) return;
      applyReachabilityResult(record.data.result, record.data.activeRouteId, {
        savedAt: record.createdAt,
        stale: record.expiresAt <= Date.now(),
        fallback: false,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [
    budget,
    applyReachabilityResult,
    departureDate,
    departureTime,
    memoryReady,
    reachabilityState,
    rememberLocally,
    selectedLineKeys,
    selectedPlace,
    selectedStationIds,
    stationState,
  ]);

  function activateRoute(station: ReachableStation) {
    if (!reachability || station.routeGeometry.length === 0) return;
    setActiveRouteId(station.logicalId);
    drawReachabilityMap(reachability, station);
    if (rememberLocally && selectedPlace) {
      const key = commuteMemoryKey(
        selectedPlace,
        budget,
        departureDate,
        departureTime,
        selectedStationIds,
        selectedLineKeys,
      );
      void updateCommuteCache<RememberedCommuteResult>(key, (remembered) => ({
        ...remembered,
        activeRouteId: station.logicalId,
      }));
    }
  }

  async function calculateReachability(forceRefresh = false) {
    const place = selectedPlace;
    if (!place || selectedStationIds.length === 0) return;
    setReachabilityState('loading');
    setReachability(null);
    setActiveRouteId(null);
    setReachabilityError('');
    setCommuteMemory(null);
    const cacheKey = commuteMemoryKey(
      place,
      budget,
      departureDate,
      departureTime,
      selectedStationIds,
      selectedLineKeys,
    );
    const cached = rememberLocally
      ? await readCommuteCache<RememberedCommuteResult>(cacheKey)
      : null;

    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      applyReachabilityResult(cached.data.result, cached.data.activeRouteId, {
        savedAt: cached.createdAt,
        stale: false,
        fallback: false,
      });
      return;
    }

    try {
      const response = await fetch('/api/amap/reachability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          anchor: {
            id: place.id,
            name: place.name,
            location: place.location,
          },
          budgetMinutes: budget,
          departureDate,
          departureTime,
          accessStations: stations
            .filter((station) => selectedStationIds.includes(station.id))
            .map((station) => ({
              id: station.id,
              name: station.name,
              location: station.location,
              citycode: station.citycode,
              distanceMeters: station.distanceMeters,
              availableLines: station.lines,
              allowedLines: station.lines.filter((line) =>
                selectedLineKeys.includes(stationLineKey(station.id, line)),
              ),
            })),
        }),
      });
      const payload = (await response.json()) as
        | ReachabilityResult
        | { error?: { message?: string } };
      if (!response.ok || !('directions' in payload)) {
        throw new Error(
          'error' in payload && payload.error?.message
            ? payload.error.message
            : '通勤圈计算失败，请稍后重试。',
        );
      }
      const data = payload;
      const initialStation =
        data.directions.to.farthest ?? data.directions.to.stations[0];
      const savedAt = Date.now();
      applyReachabilityResult(
        data,
        initialStation?.logicalId ?? null,
        rememberLocally ? { savedAt, stale: false, fallback: false } : null,
      );
      if (rememberLocally) {
        void writeCommuteCache(cacheKey, {
          result: data,
          activeRouteId: initialStation?.logicalId ?? null,
        } satisfies RememberedCommuteResult);
      }
    } catch (error) {
      if (cached) {
        applyReachabilityResult(cached.data.result, cached.data.activeRouteId, {
          savedAt: cached.createdAt,
          stale: true,
          fallback: true,
        });
        return;
      }
      setReachabilityError(
        error instanceof Error ? error.message : '通勤圈计算失败。',
      );
      setReachabilityState('error');
    }
  }

  const selectedAddress = selectedPlace
    ? [selectedPlace.district, selectedPlace.address]
        .filter(Boolean)
        .join(' · ')
    : '';
  const activeRouteStation = reachability
    ? (reachability.directions.to.stations.find(
        (station) => station.logicalId === activeRouteId,
      ) ?? reachability.directions.to.farthest)
    : null;
  const accessRouteGroups = (
    reachability?.directions.to.accessRoutes ?? []
  ).map((group, index) => ({
    ...group,
    index: index + 1,
    routes: group.routeIds
      .map((routeId) =>
        reachability?.directions.to.stations.find(
          (station) => station.logicalId === routeId,
        ),
      )
      .filter((station): station is ReachableStation => Boolean(station)),
  }));
  const overviewRouteCount = accessRouteGroups.filter(
    (group) => group.farthestRouteId,
  ).length;
  const seenLegendLines = new Set<string>();
  const routeLineLegend = routeVisuals(activeRouteStation)
    .filter(({ segment, lineKey }) => {
      if (segment.mode !== 'TRANSIT' || seenLegendLines.has(lineKey))
        return false;
      seenLegendLines.add(lineKey);
      return true;
    })
    .map(({ lineKey, lineLabel, color }) => ({
      key: lineKey,
      label: lineLabel,
      color,
    }));

  return (
    <main className="planner-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span />
          </div>
          <div>
            <p className="brand-name">通勤圈</p>
            <p className="brand-caption">租房通勤助手</p>
          </div>
        </div>
        <div className="header-actions">
          {!showOnboarding && (
            <button
              type="button"
              className="header-setup-action"
              onClick={() => setShowOnboarding(true)}
            >
              <Settings2 aria-hidden="true" /> 重新设置
            </button>
          )}
          <div className="header-status">
            <span className={`status-light ${mapState}`} />
            {mapState === 'ready'
              ? '高德地图已连接'
              : mapState === 'error'
                ? '地图加载失败'
                : '正在连接地图'}
          </div>
        </div>
      </header>

      {showOnboarding && (
        <section className="onboarding-page" aria-labelledby="onboarding-title">
          {!memoryReady ? (
            <div className="onboarding-loading" role="status">
              <span className="map-pulse" />
              <strong>正在读取本机设置</strong>
              <small>马上就好…</small>
            </div>
          ) : (
            <div className="onboarding-layout">
              <div className="onboarding-form-card">
                <div className="onboarding-heading">
                  <span className="step-kicker">开始规划</span>
                  <h1 id="onboarding-title">先设置每天要去的地方</h1>
                  <p>完成基础条件后进入地图，再选择附近站点和具体线路。</p>
                </div>

                <ol className="onboarding-steps" aria-label="初始化步骤">
                  <li className={selectedPlace ? 'is-complete' : 'is-active'}>
                    <span>{selectedPlace ? <CircleCheck /> : '1'}</span>
                    工作地点
                  </li>
                  <li className={selectedPlace ? 'is-active' : undefined}>
                    <span>2</span>
                    通勤偏好
                  </li>
                  <li>
                    <span>3</span>
                    进入地图
                  </li>
                </ol>

                <div className="onboarding-search-block">
                  <label htmlFor="onboarding-place-search">工作地点</label>
                  <div className="search-input-wrap">
                    <Search aria-hidden="true" />
                    <Input
                      id="onboarding-place-search"
                      value={query}
                      onChange={(event) =>
                        handleQueryChange(event.target.value)
                      }
                      placeholder="搜索公司、园区或学校"
                      autoComplete="off"
                      autoFocus={!selectedPlace}
                    />
                    {searching && (
                      <span className="search-spinner" aria-label="搜索中" />
                    )}
                  </div>
                  {tips.length > 0 && (
                    <div className="suggestion-list" aria-label="地点建议">
                      {tips.map((tip) => (
                        <button
                          type="button"
                          key={tip.id}
                          onClick={() => selectPlace(tip)}
                        >
                          <MapPin aria-hidden="true" />
                          <span>
                            <strong>{tip.name}</strong>
                            <small>
                              {[tip.district, tip.address]
                                .filter(Boolean)
                                .join(' · ')}
                            </small>
                          </span>
                          <ChevronRight aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  )}
                  {recentPlaces.length > 0 && !tips.length && (
                    <div className="onboarding-recent-list">
                      <span>最近使用</span>
                      <div>
                        {recentPlaces.map((place) => (
                          <button
                            type="button"
                            key={`${place.id}:${place.location}`}
                            onClick={() => selectPlace(place)}
                          >
                            <History aria-hidden="true" /> {place.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {selectedPlace && (
                    <div className="onboarding-selected-place">
                      <CircleCheck aria-hidden="true" />
                      <span>
                        <strong>{selectedPlace.name}</strong>
                        <small>{selectedAddress || '地址信息暂缺'}</small>
                      </span>
                    </div>
                  )}
                </div>

                <div className="onboarding-preferences">
                  <fieldset>
                    <legend>最长通勤时间</legend>
                    <div className="onboarding-budget-options">
                      {[30, 45, 60].map((minutes) => (
                        <button
                          type="button"
                          key={minutes}
                          className={budget === minutes ? 'is-selected' : ''}
                          aria-pressed={budget === minutes}
                          onClick={() => {
                            setBudget(minutes);
                            resetReachability();
                          }}
                        >
                          {minutes} 分钟
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <label htmlFor="onboarding-departure-time">
                    <span>通常出发时间</span>
                    <Input
                      id="onboarding-departure-time"
                      type="time"
                      value={departureTime}
                      onChange={(event) => {
                        setDepartureTime(event.target.value);
                        resetReachability();
                      }}
                    />
                  </label>
                </div>

                <div className="onboarding-memory-row">
                  <Database aria-hidden="true" />
                  <span>
                    <strong>在这台设备记住设置</strong>
                    <small>下次直接恢复，不保存地图密钥</small>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    className="memory-toggle"
                    aria-checked={rememberLocally}
                    aria-label="在本机记住初始化设置"
                    onClick={() => setMemoryPreference(!rememberLocally)}
                  >
                    <span />
                  </button>
                </div>

                <div className="onboarding-actions">
                  <Button
                    size="lg"
                    disabled={!selectedPlace}
                    onClick={() => setShowOnboarding(false)}
                  >
                    进入通勤规划 <ArrowRight aria-hidden="true" />
                  </Button>
                  <button
                    type="button"
                    onClick={() => setShowOnboarding(false)}
                  >
                    暂时跳过，先查看地图
                  </button>
                </div>
              </div>

              <aside className="onboarding-summary" aria-label="当前设置摘要">
                <span className="step-kicker">当前计划</span>
                <h2>{selectedPlace?.name ?? '等待选择工作地点'}</h2>
                <dl>
                  <div>
                    <dt>通勤预算</dt>
                    <dd>{budget} 分钟</dd>
                  </div>
                  <div>
                    <dt>出发时间</dt>
                    <dd>{departureTime}</dd>
                  </div>
                  <div>
                    <dt>本机记忆</dt>
                    <dd>{rememberLocally ? '已开启' : '未开启'}</dd>
                  </div>
                </dl>
                <div className="onboarding-next-steps">
                  <strong>进入地图后</strong>
                  <ol>
                    <li>查询 500 米、1 公里或 1.5 公里内的站点</li>
                    <li>选择最多 3 个接驳站和允许乘坐的线路</li>
                    <li>比较各接驳站分别可达的住所侧路线</li>
                  </ol>
                </div>
              </aside>
            </div>
          )}
        </section>
      )}

      <section
        className={`workspace${showOnboarding ? ' is-obscured' : ''}`}
        aria-hidden={showOnboarding}
        inert={showOnboarding ? true : undefined}
      >
        <aside className="control-panel" aria-label="通勤条件">
          <div className="panel-heading">
            <span className="step-kicker">01 · 确定工作地点</span>
            <h1>从通勤时间，反推适合居住的范围</h1>
            <p>先选择公司或学校，我们会查找附近的公共交通站点。</p>
          </div>

          <div className="search-block">
            <label htmlFor="place-search">工作地点</label>
            <div className="search-input-wrap">
              <Search aria-hidden="true" />
              <Input
                id="place-search"
                value={query}
                onChange={(event) => handleQueryChange(event.target.value)}
                placeholder="搜索公司、园区或学校"
                autoComplete="off"
              />
              {searching && (
                <span className="search-spinner" aria-label="搜索中" />
              )}
            </div>

            {tips.length > 0 && (
              <div className="suggestion-list" aria-label="地点建议">
                {tips.map((tip) => (
                  <button
                    type="button"
                    key={tip.id}
                    onClick={() => selectPlace(tip)}
                  >
                    <MapPin aria-hidden="true" />
                    <span>
                      <strong>{tip.name}</strong>
                      <small>
                        {[tip.district, tip.address]
                          .filter(Boolean)
                          .join(' · ')}
                      </small>
                    </span>
                    <ChevronRight aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}

            {recentPlaces.length > 0 && (
              <div className="recent-place-list" aria-label="最近工作地点">
                <span>
                  <History aria-hidden="true" /> 最近使用
                </span>
                <div>
                  {recentPlaces.map((place) => (
                    <button
                      type="button"
                      key={`${place.id}:${place.location}`}
                      onClick={() => selectPlace(place)}
                      title={place.address || place.district}
                    >
                      {place.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {selectedPlace && (
            <div className="selected-place-card">
              <div className="selected-place-icon">
                <Building2 aria-hidden="true" />
              </div>
              <div>
                <small>已选择</small>
                <strong>{selectedPlace.name}</strong>
                <span>{selectedAddress || '地址信息暂缺'}</span>
              </div>
            </div>
          )}

          <div className="local-memory-card">
            <div>
              <Database aria-hidden="true" />
              <span>
                <strong>仅在这台设备记住</strong>
                <small>5 个地点 · 6 组站点 · 4 次通勤结果，不保存密钥</small>
              </span>
              <button
                type="button"
                role="switch"
                className="memory-toggle"
                aria-checked={rememberLocally}
                aria-label="在本机记住工作地点和通勤条件"
                onClick={() => setMemoryPreference(!rememberLocally)}
              >
                <span />
              </button>
            </div>
            {memoryMessage && <p>{memoryMessage}</p>}
            <button
              type="button"
              disabled={!rememberLocally}
              onClick={() => {
                skipMemoryWriteRef.current = true;
                setMemoryClearNonce((value) => value + 1);
                void clearAllLocalMemory();
                setRecentPlaces([]);
                setStationMemory(null);
                setCommuteMemory(null);
                setMemoryMessage('已清除本机保存的地点和条件');
              }}
            >
              <Trash2 aria-hidden="true" /> 清除本机记录
            </button>
          </div>

          <div className="condition-section">
            <div className="section-title-row">
              <span className="step-kicker">02 · 设置通勤条件</span>
              <span className="budget-value">{budget} 分钟</span>
            </div>
            <Slider
              value={[budget]}
              min={20}
              max={90}
              step={5}
              onValueChange={(value) =>
                (() => {
                  setBudget(
                    typeof value === 'number' ? value : (value[0] ?? 45),
                  );
                  resetReachability();
                })()
              }
              aria-label="最长通勤时间"
            />
            <div className="slider-labels" aria-hidden="true">
              <span>20</span>
              <span>45</span>
              <span>90 分钟</span>
            </div>

            <div className="one-way-note">
              <ChevronRight aria-hidden="true" />
              <span>
                <strong>按住所 → 公司核验</strong>
                <small>只计算上班方向，减少一半路线检索</small>
              </span>
            </div>

            <div className="date-time-grid">
              <label htmlFor="departure-date">
                <span>
                  <CalendarDays /> 出发日期
                </span>
                <Input
                  id="departure-date"
                  type="date"
                  value={departureDate}
                  onChange={(event) => {
                    setDepartureDate(event.target.value);
                    resetReachability();
                  }}
                />
              </label>
              <label htmlFor="departure-time">
                <span>
                  <Clock3 /> 出发时间
                </span>
                <Input
                  id="departure-time"
                  type="time"
                  value={departureTime}
                  onChange={(event) => {
                    setDepartureTime(event.target.value);
                    resetReachability();
                  }}
                />
              </label>
            </div>
          </div>

          <div className="station-range-section">
            <div>
              <span>附近站点范围</span>
              <small>建议先从 500 米开始，不够再扩大</small>
            </div>
            <div
              className="station-range-control"
              role="radiogroup"
              aria-label="附近站点搜索范围"
            >
              {[
                { value: 500, label: '500 米' },
                { value: 1000, label: '1 公里' },
                { value: 1500, label: '1.5 公里' },
              ].map((option) => (
                <label key={option.value}>
                  <input
                    type="radio"
                    name="station-radius"
                    value={option.value}
                    checked={stationRadius === option.value}
                    disabled={stationState === 'loading'}
                    onChange={() => {
                      setStationRadius(option.value as 500 | 1000 | 1500);
                      resetNearbyStations();
                    }}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </div>

          <Button
            size="lg"
            className="primary-action"
            disabled={!selectedPlace || stationState === 'loading'}
            onClick={findStations}
          >
            {stationState === 'loading' ? (
              '正在查找站点…'
            ) : stationState === 'ready' ? (
              <>
                <RefreshCw /> 刷新附近站点
              </>
            ) : (
              <>
                <LocateFixed /> 查找附近公共交通
              </>
            )}
          </Button>

          {stationState === 'error' && (
            <p className="inline-error">
              <CircleAlert />
              站点查询失败，请稍后重试。
            </p>
          )}

          {stationState === 'ready' && (
            <div className="station-results">
              <div className="result-heading">
                <div>
                  <span className="step-kicker">03 · 附近站点</span>
                  <strong>
                    {stationRadius === 500
                      ? '500 米'
                      : stationRadius === 1000
                        ? '1 公里'
                        : '1.5 公里'}
                    内找到 {stations.length} 个站点
                  </strong>
                </div>
                <Sparkles aria-hidden="true" />
              </div>
              <div className="station-summary">
                <span>
                  <TrainFront />
                  轨道交通 {groupedStations.rail.length}
                </span>
                <span>
                  <BusFront />
                  公交 {groupedStations.bus.length}
                </span>
              </div>
              {stationMemory && (
                <div
                  className={`memory-source-note${stationMemory.stale ? ' is-stale' : ''}`}
                >
                  <Database aria-hidden="true" />
                  <span>
                    {stationMemory.stale ? '备用的本机记录' : '本机站点记录'} ·{' '}
                    {memoryAgeLabel(stationMemory.savedAt)}
                  </span>
                  {stationMemory.stale && <strong>建议刷新</strong>}
                </div>
              )}
              <div className="station-selection-summary">
                <strong>已选 {selectedStationIds.length} / 3 个接驳站点</strong>
                <small>选中线路会限定路线；不选线路表示允许该站全部线路</small>
              </div>
              <div className="station-list">
                {(showAllStations ? stations : stations.slice(0, 6)).map(
                  (station, index) => {
                    const isSelected = selectedStationIds.includes(station.id);
                    const visibleLines = isSelected
                      ? station.lines
                      : station.lines.slice(0, 3);
                    return (
                      <div
                        key={station.id}
                        className={`station-list-row${isSelected ? ' is-selected' : ''}`}
                      >
                        <input
                          type="checkbox"
                          className="station-select-checkbox"
                          checked={isSelected}
                          disabled={
                            !isSelected && selectedStationIds.length >= 3
                          }
                          onChange={(event) =>
                            setStationSelected(station.id, event.target.checked)
                          }
                          aria-label={`${isSelected ? '取消选择' : '选择'}${station.name}`}
                        />
                        <button
                          type="button"
                          className="station-focus-action"
                          onClick={() => {
                            mapRef.current?.setCenter(
                              parseLocation(station.location),
                            );
                            mapRef.current?.setZoom(17);
                          }}
                        >
                          <span
                            className={`station-mode ${station.mode.toLowerCase()}`}
                          >
                            <b>{index + 1}</b>
                          </span>
                          <span className="station-detail-copy">
                            <strong>{station.name}</strong>
                            <small>直线距离 {station.distanceMeters} 米</small>
                          </span>
                          <ChevronRight />
                        </button>
                        <div className="station-line-chips is-selectable">
                          {visibleLines.length > 0 ? (
                            <>
                              {visibleLines.map((line) => {
                                const lineSelected = selectedLineKeys.includes(
                                  stationLineKey(station.id, line),
                                );
                                return (
                                  <button
                                    type="button"
                                    key={line}
                                    disabled={!isSelected}
                                    className={
                                      lineSelected ? 'is-selected' : ''
                                    }
                                    aria-pressed={lineSelected}
                                    onClick={() =>
                                      toggleStationLine(station.id, line)
                                    }
                                  >
                                    {line}
                                  </button>
                                );
                              })}
                              {!isSelected && station.lines.length > 3 && (
                                <span>+{station.lines.length - 3}</span>
                              )}
                            </>
                          ) : (
                            <span className="is-empty">暂无线路信息</span>
                          )}
                        </div>
                      </div>
                    );
                  },
                )}
              </div>
              {stations.length > 6 && (
                <button
                  type="button"
                  className="station-list-toggle"
                  onClick={() => setShowAllStations((visible) => !visible)}
                >
                  {showAllStations
                    ? '收起站点列表'
                    : `查看全部 ${stations.length} 个站点及线路`}
                </button>
              )}

              <Button
                size="lg"
                className="calculate-action"
                disabled={
                  reachabilityState === 'loading' ||
                  selectedStationIds.length === 0
                }
                onClick={() => void calculateReachability()}
              >
                <Radar />
                {reachabilityState === 'loading'
                  ? '正在规划候选路线…'
                  : selectedStationIds.length === 0
                    ? '请先选择接驳站点'
                    : `按 ${selectedStationIds.length} 个站点计算 ${budget} 分钟上班通勤圈`}
              </Button>

              {reachabilityState === 'loading' && (
                <output className="scan-progress">
                  <span className="search-spinner" />
                  <div>
                    <strong>正在展开接驳站的线路与完整站序</strong>
                    <small>
                      再按剩余预算核验住所到公司的公交路线，通常需要 8～30 秒。
                    </small>
                  </div>
                </output>
              )}

              {reachabilityState === 'error' && (
                <p className="inline-error">
                  <CircleAlert />
                  {reachabilityError || '通勤圈计算失败，请稍后重试。'}
                </p>
              )}
            </div>
          )}

          {reachabilityState === 'ready' && reachability && (
            <div className="reachability-results">
              <div className="result-heading">
                <div>
                  <span className="step-kicker">04 · 通勤圈结果</span>
                  <strong>
                    住所到公司可达 {reachability.directions.to.reachableCount}{' '}
                    条路线
                  </strong>
                </div>
                <Radar aria-hidden="true" />
              </div>

              {commuteMemory && (
                <div
                  className={`memory-source-note commute-memory-note${commuteMemory.stale ? ' is-stale' : ''}`}
                >
                  <Database aria-hidden="true" />
                  <span>
                    {commuteMemory.fallback
                      ? '接口失败，已显示上次成功结果'
                      : commuteMemory.stale
                        ? '上次保存的通勤结果'
                        : '本机通勤结果'}{' '}
                    · {memoryAgeLabel(commuteMemory.savedAt)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void calculateReachability(true)}
                  >
                    <RefreshCw aria-hidden="true" /> 更新
                  </button>
                </div>
              )}

              <div className="scan-metrics">
                <span>
                  <strong>{reachability.selectedAccessStationCount}</strong>
                  接驳站点
                </span>
                <span>
                  <strong>{reachability.candidateCount}</strong>候选站点
                </span>
                <span>
                  <strong>{reachability.lineQueryCount}</strong>线路查询
                </span>
                <span>
                  <strong>{reachability.expandedLineCount}</strong>线路方向
                </span>
                <span>
                  <strong>{reachability.routeCheckCount}</strong>路线核验
                </span>
                <span>
                  <strong>
                    {(reachability.networkSpanMeters / 1000).toFixed(1)} km
                  </strong>
                  沿线跨度
                </span>
              </div>

              <div className="access-budget-list">
                {reachability.accessStationBudgets.map((station) => (
                  <span key={station.id}>
                    <strong>{station.name}</strong>
                    步行 {station.walkingMinutes} 分钟 · 公交预算{' '}
                    {station.remainingTransitMinutes} 分钟
                  </span>
                ))}
              </div>

              <div className="direction-results">
                <section className="direction-result">
                  <div className="direction-result-heading">
                    <strong>住所 → 公司</strong>
                    <span>{accessRouteGroups.length} 个接驳站分别计算</span>
                  </div>

                  {reachability.directions.to.farthest ? (
                    <div className="farthest-card">
                      <span className="farthest-icon">
                        <Trophy />
                      </span>
                      <div>
                        <small>最远可达住所侧站点</small>
                        <strong>
                          {reachability.directions.to.farthest.name}
                        </strong>
                        <span>
                          总计{' '}
                          {reachability.directions.to.farthest.durationMinutes}{' '}
                          分钟 · 直线{' '}
                          {(
                            reachability.directions.to.farthest
                              .straightLineMeters / 1000
                          ).toFixed(1)}{' '}
                          公里
                        </span>
                        <span className="route-access-note">
                          到{' '}
                          {
                            reachability.directions.to.farthest.accessStation
                              .name
                          }{' '}
                          · 公交{' '}
                          {
                            reachability.directions.to.farthest
                              .transitDurationMinutes
                          }{' '}
                          分钟 + 步行{' '}
                          {
                            reachability.directions.to.farthest.accessStation
                              .walkingMinutes
                          }{' '}
                          分钟
                        </span>
                      </div>
                    </div>
                  ) : reachability.directions.to.nearMisses[0] ? (
                    <div className="farthest-card is-near-miss">
                      <span className="farthest-icon">
                        <Clock3 />
                      </span>
                      <div>
                        <small>最接近预算的候选</small>
                        <strong>
                          {reachability.directions.to.nearMisses[0].name}
                        </strong>
                        <span>
                          需要{' '}
                          {
                            reachability.directions.to.nearMisses[0]
                              .durationMinutes
                          }{' '}
                          分钟，超出预算{' '}
                          {Math.max(
                            1,
                            reachability.directions.to.nearMisses[0]
                              .durationMinutes - budget,
                          )}{' '}
                          分钟
                        </span>
                      </div>
                    </div>
                  ) : (
                    <p className="direction-empty">暂无有效候选路线</p>
                  )}

                  <div className="access-route-groups">
                    {accessRouteGroups.map((group) => (
                      <section
                        className="access-route-group"
                        key={group.accessStationId}
                      >
                        <div className="access-route-group-heading">
                          <strong>
                            <span>司{group.index}</span>
                            {group.accessStationName}
                          </strong>
                          <small>{group.reachableCount} 条可达路线</small>
                        </div>
                        {group.routes.length > 0 ? (
                          <div className="reachability-list">
                            {group.routes.map((station, routeIndex) => (
                              <button
                                type="button"
                                key={station.logicalId}
                                className={
                                  activeRouteId === station.logicalId
                                    ? 'is-active'
                                    : undefined
                                }
                                aria-pressed={
                                  activeRouteId === station.logicalId
                                }
                                onClick={() => activateRoute(station)}
                              >
                                <span className="result-rank">
                                  {routeIndex + 1}
                                </span>
                                <span>
                                  <strong>{station.name}</strong>
                                  <small>
                                    {station.mode === 'BUS'
                                      ? '公交站'
                                      : station.mode === 'LIGHT_RAIL'
                                        ? '有轨电车 / 轻轨'
                                        : '地铁站'}{' '}
                                    · 直线{' '}
                                    {(
                                      station.straightLineMeters / 1000
                                    ).toFixed(1)}{' '}
                                    公里
                                  </small>
                                  <small>
                                    到 {station.accessStation.name} · 公交{' '}
                                    {station.transitDurationMinutes} + 步行{' '}
                                    {station.accessStation.walkingMinutes} 分钟
                                  </small>
                                  {station.routeLines.length > 0 && (
                                    <small>
                                      {station.routeLines
                                        .slice(0, 3)
                                        .join(' / ')}
                                    </small>
                                  )}
                                </span>
                                <span className="duration-chip">
                                  {activeRouteId === station.logicalId
                                    ? '已高亮'
                                    : `${station.durationMinutes} 分钟`}
                                </span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="direction-empty">
                            当前预算内没有经该接驳站到公司的可达样本
                          </p>
                        )}
                      </section>
                    ))}
                  </div>
                </section>
              </div>
              <p className="sampling-note">
                每个接驳站分别保留可达路线；地图默认同时显示各站最远路线，点击候选可单独高亮并查看完整途经站。
              </p>
            </div>
          )}
        </aside>

        <div className="map-panel" aria-label="地图区域">
          <div ref={mapContainerRef} className="map-canvas" />
          {mapState !== 'ready' && (
            <div className="map-loading-state">
              <div className="map-grid" />
              <div className="map-loading-card">
                {mapState === 'loading' ? (
                  <>
                    <span className="map-pulse" />
                    <strong>正在加载高德地图</strong>
                    <small>连接地图与地点服务…</small>
                  </>
                ) : (
                  <>
                    <CircleAlert />
                    <strong>地图暂时无法加载</strong>
                    <small>请检查 JS API 域名白名单后刷新页面。</small>
                  </>
                )}
              </div>
            </div>
          )}

          <div className="map-legend">
            <span>
              <i className="legend-anchor" />
              工作地点
            </span>
            <span>
              <i className="legend-rail" />
              地铁 / 轻轨
            </span>
            <span>
              <i className="legend-bus" />
              公交站
            </span>
            {reachabilityState === 'ready' && (
              <>
                <span>
                  <i className="legend-farthest" />
                  最远可达
                </span>
                {overviewRouteCount > 1 && (
                  <span>
                    <i className="legend-overview-route" />
                    其他接驳站路线
                  </span>
                )}
                {routeLineLegend.map((line) => (
                  <span key={line.key} title={line.label}>
                    <i
                      className="legend-route-line"
                      style={{ backgroundColor: line.color }}
                    />
                    {line.label}
                  </span>
                ))}
              </>
            )}
          </div>
          <div className="map-context-card">
            <small>当前计划</small>
            <strong>
              {budget} 分钟 · 工作日 {departureTime}
            </strong>
            <span>住所 → 工作地点，单向路线核验</span>
          </div>
        </div>
      </section>
    </main>
  );
}
