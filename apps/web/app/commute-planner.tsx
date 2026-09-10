'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Building2,
  BusFront,
  CalendarDays,
  ChevronRight,
  CircleAlert,
  Clock3,
  LocateFixed,
  MapPin,
  Radar,
  Search,
  Sparkles,
  TrainFront,
  Trophy,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Slider } from '@/components/ui/slider';

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
  durationSeconds: number;
  durationMinutes: number;
  straightLineMeters: number;
  segmentCount: number;
};

type ReachabilityResult = {
  sampled: true;
  budgetMinutes: number;
  scanRadiusMeters: number;
  candidateCount: number;
  checkedCount: number;
  failedCount: number;
  reachableCount: number;
  fastestCandidateMinutes: number | null;
  farthest: ReachableStation | null;
  nearMisses: ReachableStation[];
  stations: ReachableStation[];
  cached?: boolean;
};

type AMapMarker = { setMap(map: AMapMap | null): void };
type AMapMap = {
  setCenter(position: [number, number]): void;
  setZoom(zoom: number): void;
  setFitView(
    overlays?: AMapMarker[],
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

function parseLocation(location: string): [number, number] {
  const [longitude, latitude] = location.split(',').map(Number);
  return [longitude, latitude];
}

function tomorrowAsInputValue() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
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
  const overlaysRef = useRef<AMapMarker[]>([]);
  const anchorMarkerRef = useRef<AMapMarker | null>(null);
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
  const [stationState, setStationState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [reachabilityState, setReachabilityState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [reachability, setReachability] = useState<ReachabilityResult | null>(
    null,
  );
  const [budget, setBudget] = useState(45);
  const [direction, setDirection] = useState<'to' | 'from'>('to');
  const [departureDate, setDepartureDate] = useState(tomorrowAsInputValue);
  const [departureTime, setDepartureTime] = useState('08:30');

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
            '填写可见的工作地点关键词、通勤方向、时间预算和出发时间。',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', minLength: 2, maxLength: 80 },
              budgetMinutes: { type: 'integer', minimum: 20, maximum: 90 },
              direction: { type: 'string', enum: ['to_work', 'from_work'] },
              departureDate: { type: 'string', format: 'date' },
              departureTime: {
                type: 'string',
                pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
              },
            },
            required: ['query', 'budgetMinutes', 'direction'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute(input) {
            const value = input as Record<string, unknown>;
            const nextQuery =
              typeof value.query === 'string' ? value.query.trim() : '';
            const nextBudget = Number(value.budgetMinutes);
            const nextDirection = value.direction;
            if (
              nextQuery.length < 2 ||
              nextQuery.length > 80 ||
              !Number.isInteger(nextBudget) ||
              nextBudget < 20 ||
              nextBudget > 90 ||
              (nextDirection !== 'to_work' && nextDirection !== 'from_work')
            ) {
              throw new Error('通勤查询参数无效。');
            }

            setSelectedPlace(null);
            setStations([]);
            setShowAllStations(false);
            setStationState('idle');
            setReachability(null);
            setReachabilityState('idle');
            overlaysRef.current.forEach((overlay) => overlay.setMap(null));
            overlaysRef.current = [];
            anchorMarkerRef.current = null;
            setQuery(nextQuery);
            setBudget(nextBudget);
            setDirection(nextDirection === 'to_work' ? 'to' : 'from');
            if (typeof value.departureDate === 'string')
              setDepartureDate(value.departureDate);
            if (typeof value.departureTime === 'string')
              setDepartureTime(value.departureTime);

            return {
              query: nextQuery,
              budgetMinutes: nextBudget,
              direction: nextDirection,
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

  function clearMapOverlays() {
    overlaysRef.current.forEach((overlay) => overlay.setMap(null));
    overlaysRef.current = [];
  }

  function resetReachability() {
    setReachability(null);
    setReachabilityState('idle');
  }

  function resetNearbyStations() {
    setStations([]);
    setShowAllStations(false);
    setStationState('idle');
    resetReachability();

    const map = mapRef.current;
    clearMapOverlays();
    if (map && anchorMarkerRef.current) {
      anchorMarkerRef.current.setMap(map);
      overlaysRef.current.push(anchorMarkerRef.current);
    }
  }

  function selectPlace(place: PlaceTip) {
    setSelectedPlace(place);
    setQuery(place.name);
    setTips([]);
    setStations([]);
    setShowAllStations(false);
    setStationState('idle');
    resetReachability();
    clearMapOverlays();

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

  async function findStations() {
    if (!selectedPlace) return;
    setStationState('loading');
    resetReachability();
    setShowAllStations(false);

    try {
      const response = await fetch(
        `/api/amap/stations?location=${encodeURIComponent(selectedPlace.location)}&radius=${stationRadius}`,
      );
      if (!response.ok) throw new Error('Station search failed');
      const data = (await response.json()) as { stations: Station[] };
      setStations(data.stations);
      setStationState('ready');

      const AMap = amapRef.current;
      const map = mapRef.current;
      if (!AMap || !map) return;
      clearMapOverlays();
      const anchor = anchorMarkerRef.current;
      if (anchor) {
        anchor.setMap(map);
        overlaysRef.current.push(anchor);
      }

      const markers = data.stations.map(
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
    } catch {
      setStationState('error');
    }
  }

  async function calculateReachability() {
    if (!selectedPlace) return;
    setReachabilityState('loading');
    setReachability(null);

    try {
      const response = await fetch('/api/amap/reachability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          anchor: {
            id: selectedPlace.id,
            name: selectedPlace.name,
            location: selectedPlace.location,
          },
          budgetMinutes: budget,
          direction,
          departureDate,
          departureTime,
        }),
      });
      if (!response.ok) throw new Error('Reachability scan failed');
      const data = (await response.json()) as ReachabilityResult;
      setReachability(data);
      setReachabilityState('ready');

      const AMap = amapRef.current;
      const map = mapRef.current;
      if (!AMap || !map) return;
      clearMapOverlays();
      const anchor = anchorMarkerRef.current;
      if (anchor) {
        anchor.setMap(map);
        overlaysRef.current.push(anchor);
      }

      const markers = data.stations.map((station) => {
        const isFarthest = station.id === data.farthest?.id;
        const modeClass = station.mode === 'BUS' ? 'is-bus' : 'is-rail';
        return new AMap.Marker({
          map,
          position: parseLocation(station.location),
          anchor: 'center',
          title: `${station.name} · ${station.durationMinutes} 分钟`,
          content: `<span class="reachable-map-marker ${modeClass}${isFarthest ? ' is-farthest' : ''}"><em>${station.durationMinutes}</em></span>`,
        });
      });
      overlaysRef.current.push(...markers);
      map.setFitView(overlaysRef.current, false, [90, 70, 90, 430]);
    } catch {
      setReachabilityState('error');
    }
  }

  const selectedAddress = selectedPlace
    ? [selectedPlace.district, selectedPlace.address]
        .filter(Boolean)
        .join(' · ')
    : '';

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
        <div className="header-status">
          <span className={`status-light ${mapState}`} />
          {mapState === 'ready'
            ? '高德地图已连接'
            : mapState === 'error'
              ? '地图加载失败'
              : '正在连接地图'}
        </div>
      </header>

      <section className="workspace">
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
                onChange={(event) => {
                  setQuery(event.target.value);
                  if (event.target.value.trim().length < 2) setTips([]);
                  if (selectedPlace?.name !== event.target.value) {
                    setSelectedPlace(null);
                    setStations([]);
                    setShowAllStations(false);
                    resetReachability();
                    clearMapOverlays();
                    anchorMarkerRef.current = null;
                  }
                }}
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

            <div className="direction-switch" aria-label="通勤方向">
              <button
                type="button"
                className={direction === 'to' ? 'active' : ''}
                onClick={() => {
                  setDirection('to');
                  resetReachability();
                }}
              >
                住处 <ArrowRight /> 公司
              </button>
              <button
                type="button"
                className={direction === 'from' ? 'active' : ''}
                onClick={() => {
                  setDirection('from');
                  resetReachability();
                }}
              >
                公司 <ArrowRight /> 住处
              </button>
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
            <RadioGroup
              className="station-range-control"
              value={String(stationRadius)}
              onValueChange={(value) => {
                const nextRadius = Number(value);
                if (
                  nextRadius === 500 ||
                  nextRadius === 1000 ||
                  nextRadius === 1500
                ) {
                  setStationRadius(nextRadius);
                  resetNearbyStations();
                }
              }}
              aria-label="附近站点搜索范围"
            >
              {[
                { value: 500, label: '500 米' },
                { value: 1000, label: '1 公里' },
                { value: 1500, label: '1.5 公里' },
              ].map((option) => (
                <label key={option.value}>
                  <RadioGroupItem
                    value={String(option.value)}
                    disabled={stationState === 'loading'}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </RadioGroup>
          </div>

          <Button
            size="lg"
            className="primary-action"
            disabled={!selectedPlace || stationState === 'loading'}
            onClick={findStations}
          >
            {stationState === 'loading' ? (
              '正在查找站点…'
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
              <div className="station-list">
                {(showAllStations ? stations : stations.slice(0, 6)).map(
                  (station, index) => (
                    <button
                      type="button"
                      key={station.id}
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
                        <span className="station-line-chips">
                          {station.lines.length > 0 ? (
                            <>
                              {station.lines.slice(0, 3).map((line) => (
                                <i key={line}>{line}</i>
                              ))}
                              {station.lines.length > 3 && (
                                <i>+{station.lines.length - 3}</i>
                              )}
                            </>
                          ) : (
                            <i className="is-empty">暂无线路信息</i>
                          )}
                        </span>
                      </span>
                      <ChevronRight />
                    </button>
                  ),
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
                disabled={reachabilityState === 'loading'}
                onClick={calculateReachability}
              >
                <Radar />
                {reachabilityState === 'loading'
                  ? '正在规划候选路线…'
                  : `计算 ${budget} 分钟通勤圈`}
              </Button>

              {reachabilityState === 'loading' && (
                <output className="scan-progress">
                  <span className="search-spinner" />
                  <div>
                    <strong>正在扫描 8 个方向</strong>
                    <small>批量比较候选站点路线，通常需要 10～30 秒。</small>
                  </div>
                </output>
              )}

              {reachabilityState === 'error' && (
                <p className="inline-error">
                  <CircleAlert />
                  通勤圈计算失败，请稍后重试。
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
                    {reachability.reachableCount > 0
                      ? `找到 ${reachability.reachableCount} 个可达站点`
                      : '当前样本中没有可达站点'}
                  </strong>
                </div>
                <Radar aria-hidden="true" />
              </div>

              {reachability.farthest && (
                <div className="farthest-card">
                  <span className="farthest-icon">
                    <Trophy />
                  </span>
                  <div>
                    <small>本轮最远可达</small>
                    <strong>{reachability.farthest.name}</strong>
                    <span>
                      {reachability.farthest.durationMinutes} 分钟 · 直线
                      {(
                        reachability.farthest.straightLineMeters / 1000
                      ).toFixed(1)}{' '}
                      公里
                    </span>
                  </div>
                </div>
              )}

              {!reachability.farthest && reachability.nearMisses[0] && (
                <div className="farthest-card is-near-miss">
                  <span className="farthest-icon">
                    <Clock3 />
                  </span>
                  <div>
                    <small>最接近预算的候选</small>
                    <strong>{reachability.nearMisses[0].name}</strong>
                    <span>
                      需要 {reachability.nearMisses[0].durationMinutes} 分钟，
                      超出当前预算
                      {reachability.nearMisses[0].durationMinutes - budget} 分钟
                    </span>
                  </div>
                </div>
              )}

              <div className="scan-metrics">
                <span>
                  <strong>{reachability.candidateCount}</strong>候选站点
                </span>
                <span>
                  <strong>{reachability.checkedCount}</strong>有效路线
                </span>
                <span>
                  <strong>
                    {(reachability.scanRadiusMeters / 1000).toFixed(1)} km
                  </strong>
                  扫描半径
                </span>
              </div>

              <div className="reachability-list">
                {reachability.stations.slice(0, 6).map((station, index) => (
                  <button
                    type="button"
                    key={station.id}
                    onClick={() => {
                      mapRef.current?.setCenter(
                        parseLocation(station.location),
                      );
                      mapRef.current?.setZoom(16);
                    }}
                  >
                    <span className="result-rank">{index + 1}</span>
                    <span>
                      <strong>{station.name}</strong>
                      <small>
                        直线 {(station.straightLineMeters / 1000).toFixed(1)}{' '}
                        公里
                      </small>
                    </span>
                    <span className="duration-chip">
                      {station.durationMinutes} 分钟
                    </span>
                  </button>
                ))}
              </div>
              <p className="sampling-note">
                当前结果基于 8 个方向的候选站点抽样，不代表完整等时圈。
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
              <span>
                <i className="legend-farthest" />
                最远可达
              </span>
            )}
          </div>
          <div className="map-context-card">
            <small>当前计划</small>
            <strong>
              {budget} 分钟 · 工作日 {departureTime}
            </strong>
            <span>
              {direction === 'to' ? '住处前往工作地点' : '从工作地点返回住处'}
            </span>
          </div>
        </div>
      </section>
    </main>
  );
}
