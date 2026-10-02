/** Search order is a heuristic; only explicit route evidence proves a boundary. */
export type CheckStatus = 'reachable' | 'over_budget' | 'no_route' | 'error';
export type DirectionStatus = CheckStatus | 'unverified' | 'no_candidate';
export type Observation<T> = {
  index: number;
  status: CheckStatus;
  route?: T;
  durationSeconds?: number;
  errorCode?: string;
  checkedAt?: number;
};

export const CHECKS_PER_DIRECTION = 8;

export function summarizeBoundary<T>(
  count: number,
  observations: Observation<T>[],
) {
  const byIndex = new Map(observations.map((item) => [item.index, item]));
  const best =
    [...byIndex.values()]
      .filter((item) => item.status === 'reachable')
      .sort((a, b) => b.index - a.index)[0] ?? null;
  const unresolved = Array.from({ length: count }, (_, index) => index)
    .filter((index) => index > (best?.index ?? -1))
    .filter((index) => byIndex.get(index)?.status !== 'over_budget');
  const confirmed = count === 0 || unresolved.length === 0;
  const relevant = unresolved.map((index) => byIndex.get(index));
  const status: DirectionStatus =
    count === 0
      ? 'no_candidate'
      : best
        ? 'reachable'
        : confirmed
          ? 'over_budget'
          : relevant.some((item) => item?.status === 'error')
            ? 'error'
            : relevant.some((item) => item?.status === 'no_route')
              ? 'no_route'
              : 'unverified';
  return { best, confirmed, status, unresolved };
}

export async function searchDirection<T>(options: {
  count: number;
  previous?: Observation<T>[];
  limit?: number;
  check: (index: number) => Promise<Omit<Observation<T>, 'index'>>;
}) {
  const observed = new Map(
    (options.previous ?? []).map((item) => [item.index, item]),
  );
  const attempted = new Set<number>();
  const limit = options.limit ?? CHECKS_PER_DIRECTION;
  while (attempted.size < limit) {
    const summary = summarizeBoundary(options.count, [...observed.values()]);
    if (summary.confirmed) break;
    const eligible = (index: number) =>
      index >= 0 &&
      index < options.count &&
      !attempted.has(index) &&
      (!observed.has(index) ||
        ['error', 'no_route'].includes(observed.get(index)!.status));
    let next: number | undefined;
    // Retry inconclusive evidence once; an error never closes either boundary.
    if (options.previous?.length) {
      next = summary.unresolved.find(
        (index) => observed.has(index) && eligible(index),
      );
    }
    if (next === undefined && eligible(options.count - 1))
      next = options.count - 1;
    if (next === undefined && eligible(0)) next = 0;
    const low = summary.best?.index ?? -1;
    const high =
      [...observed.values()]
        .filter((item) => item.status === 'over_budget' && item.index > low)
        .sort((a, b) => a.index - b.index)[0]?.index ?? options.count;
    const middle = Math.floor((low + high) / 2);
    if (
      next === undefined &&
      middle > low &&
      middle < high &&
      eligible(middle)
    ) {
      next = middle;
    }
    // Audit every farther stop before calling a result the farthest. Timetable
    // durations need not be monotone, so binary search alone is not proof.
    if (next === undefined)
      next = [...summary.unresolved].reverse().find(eligible);
    if (next === undefined) break;
    attempted.add(next);
    let value: Omit<Observation<T>, 'index'>;
    try {
      value = await options.check(next);
    } catch {
      value = { status: 'error', errorCode: 'CHECK_FAILED' };
    }
    observed.set(next, { index: next, ...value });
  }
  const observations = [...observed.values()].sort((a, b) => a.index - b.index);
  return {
    ...summarizeBoundary(options.count, observations),
    observations,
    calls: attempted.size,
  };
}

export function normalizeLineName(name: string) {
  return name
    .split(/[（(]/)[0]
    .replace(/地铁|轨道交通|轨交|\s/g, '')
    .toLowerCase();
}

type Stop = { id?: string; name?: string; location?: string };
export type TransitLine = {
  id?: string;
  name?: string;
  departure_stop?: Stop;
  arrival_stop?: Stop;
  via_stops?: Stop[];
};

function sameStop(actual: Stop | undefined, expected: Stop) {
  if (!actual || !expected) return false;
  if (actual.id && actual.id === expected.id) return true;
  // AMap line lookup returns POI IDs (BV...), while route planning returns
  // line-scoped stop IDs. The exact line direction is checked separately;
  // use both the station name and nearby coordinates across those namespaces.
  if (!actual.name || actual.name.trim() !== expected.name?.trim())
    return false;
  if (!actual.location || !expected.location) return false;
  const [ax, ay] = actual.location.split(',').map(Number);
  const [bx, by] = expected.location.split(',').map(Number);
  return (
    [ax, ay, bx, by].every(Number.isFinite) &&
    Math.hypot(
      (ax - bx) * Math.cos((by * Math.PI) / 180) * 111_320,
      (ay - by) * 111_320,
    ) <= 150
  );
}

export function matchesDirectLine(
  line: TransitLine,
  expected: {
    id: string;
    name: string;
    stops: Stop[];
    boardIndex: number;
    alightIndex: number;
  },
) {
  if (expected.boardIndex < 0 || expected.alightIndex <= expected.boardIndex)
    return false;
  if (normalizeLineName(line.name ?? '') !== normalizeLineName(expected.name))
    return false;
  if (line.id && line.id !== expected.id) return false;
  // Missing IDs require the full directional name, not only the line number.
  if (
    !line.id &&
    line.name?.replace(/[（）\s]/g, (value) =>
      value === '（' ? '(' : value === '）' ? ')' : '',
    ) !==
      expected.name.replace(/[（）\s]/g, (value) =>
        value === '（' ? '(' : value === '）' ? ')' : '',
      )
  )
    return false;
  if (
    !sameStop(line.departure_stop, expected.stops[expected.boardIndex]) ||
    !sameStop(line.arrival_stop, expected.stops[expected.alightIndex])
  )
    return false;
  let previousIndex = expected.boardIndex;
  for (const via of line.via_stops ?? []) {
    const index = expected.stops.findIndex(
      (stop, i) =>
        i > previousIndex && i < expected.alightIndex && sameStop(via, stop),
    );
    if (index < 0) return false;
    previousIndex = index;
  }
  return true;
}

/** Count- and byte-bounded, best-effort Worker cache; never persists secrets. */
export class BoundedCache<T> {
  private entries = new Map<
    string,
    { value: T; expires: number; bytes: number }
  >();
  private bytes = 0;
  private limit: number;
  private maxBytes: number;
  constructor(limit: number, maxBytes = 4 * 1024 * 1024) {
    this.limit = limit;
    this.maxBytes = maxBytes;
  }
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires <= Date.now()) {
      this.delete(key);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  delete(key: string) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
  set(key: string, value: T, ttl: number) {
    this.delete(key);
    const bytes = JSON.stringify(value).length * 2;
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes, expires: Date.now() + ttl });
    this.bytes += bytes;
    while (this.entries.size > this.limit || this.bytes > this.maxBytes) {
      this.delete(this.entries.keys().next().value!);
    }
  }
}
