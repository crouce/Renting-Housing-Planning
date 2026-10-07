import type { CalculationIssue, DirectionSummary } from './reachability-types';

type Route = {
  logicalId: string;
  straightLineMeters: number;
  durationMinutes: number;
  lineDirection: { id: string };
  accessStation: { id: string };
};
type Mergeable = {
  partial: boolean;
  candidateCount: number;
  expandedLineCount: number;
  routeCheckCount: number;
  cachedDirectionCount: number;
  issues: CalculationIssue[];
  directions: {
    to: {
      stations: Route[];
      accessRoutes: Array<{
        accessStationId: string;
        accessStationName: string;
        reachableCount: number;
        farthestRouteId: string | null;
        routeIds: string[];
        directions: DirectionSummary[];
      }>;
    };
  };
};

/** A targeted retry must never erase unrelated station/line results. */
export function mergeDirectionResult<T extends Mergeable>(
  previous: T,
  next: T,
): T {
  const replacements = new Map(
    next.directions.to.accessRoutes
      .flatMap((group) => group.directions)
      .map((direction) => [direction.id, direction]),
  );
  const stations = [
    ...previous.directions.to.stations.filter(
      (station) => !replacements.has(station.lineDirection.id),
    ),
    ...next.directions.to.stations,
  ].sort((a, b) => b.straightLineMeters - a.straightLineMeters);
  const groups = new Map(
    previous.directions.to.accessRoutes.map((group) => [
      group.accessStationId,
      group,
    ]),
  );
  for (const group of next.directions.to.accessRoutes) {
    if (!groups.has(group.accessStationId))
      groups.set(group.accessStationId, group);
  }
  const accessRoutes = [...groups.values()].map((group) => {
    const incoming = next.directions.to.accessRoutes.find(
      (item) => item.accessStationId === group.accessStationId,
    );
    const directions = [
      ...new Map([
        ...group.directions.map(
          (direction) =>
            [
              direction.id,
              replacements.get(direction.id) ?? direction,
            ] as const,
        ),
        ...(incoming?.directions ?? []).map(
          (direction) => [direction.id, direction] as const,
        ),
      ]).values(),
    ];
    const routes = stations.filter(
      (station) => station.accessStation.id === group.accessStationId,
    );
    return {
      ...group,
      directions,
      reachableCount: routes.length,
      routeIds: routes.map((route) => route.logicalId),
      farthestRouteId: routes[0]?.logicalId ?? null,
    };
  });
  const directions = accessRoutes.flatMap((group) => group.directions);
  return {
    ...previous,
    partial: false,
    candidateCount: directions.reduce(
      (sum, item) => sum + item.candidateCount,
      0,
    ),
    expandedLineCount: directions.length,
    routeCheckCount: previous.routeCheckCount + next.routeCheckCount,
    cachedDirectionCount: directions.filter((direction) => direction.cached)
      .length,
    directions: {
      to: {
        ...previous.directions.to,
        stations,
        accessRoutes,
        farthest: stations[0] ?? null,
        reachableCount: stations.length,
        checkedCount: directions.reduce(
          (sum, item) => sum + item.checkedCount,
          0,
        ),
        failedCount: directions.reduce((sum, item) => sum + item.errorCount, 0),
        routeCheckCount: previous.routeCheckCount + next.routeCheckCount,
        fastestCandidateMinutes: stations.length
          ? Math.min(...stations.map((station) => station.durationMinutes))
          : null,
      },
    },
  } as T;
}
