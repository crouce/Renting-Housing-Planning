import type {
  BoardingStation,
  Community,
  CommunityVerification,
  TransitStop,
} from './community-types';

export const ROUTE_FRESH_MS = 10 * 60_000;
export const POI_FRESH_MS = 24 * 60 * 60_000;

export function isRecent(checkedAt: number, now = Date.now()) {
  return checkedAt <= now && now - checkedAt < ROUTE_FRESH_MS;
}

export function classifyCommunity(
  result: CommunityVerification,
  budgetSeconds: number,
): CommunityVerification {
  if (
    !['reachable', 'over_budget'].includes(result.status) ||
    result.totalSeconds === undefined
  )
    return result;
  return {
    ...result,
    status: result.totalSeconds <= budgetSeconds ? 'reachable' : 'over_budget',
  };
}

// Exclude derived durations and budgets, but include all route identity inputs.
export function seedIdentity(seed: BoardingStation) {
  return [
    seed.id,
    seed.station,
    seed.accessStation,
    seed.citycode,
    seed.lineId,
    seed.lineName,
    seed.stops,
  ];
}

export function communityRouteKey(
  community: TransitStop,
  anchor: TransitStop,
  seed: BoardingStation,
  date: string,
  time: string,
) {
  return JSON.stringify([
    'community-route:v2',
    community.id,
    community.location,
    anchor.id,
    anchor.location,
    seedIdentity(seed),
    date,
    time,
  ]);
}

// Replace only a successfully refreshed station's list. Failed stations retain
// their previous list. A moved POI must not inherit proof for its old location.
export function replaceStationCommunities(
  previous: Community[],
  incoming: Community[],
  seedIds: string[],
) {
  const refreshed = new Set(seedIds);
  const retained = previous.flatMap((community) => {
    const remaining = community.seedIds.filter((id) => !refreshed.has(id));
    return remaining.length ? [{ ...community, seedIds: remaining }] : [];
  });
  const byId = new Map(retained.map((community) => [community.id, community]));
  for (const community of incoming) {
    const old = byId.get(community.id);
    byId.set(community.id, {
      ...community,
      seedIds:
        old?.location === community.location
          ? [...new Set([...old.seedIds, ...community.seedIds])]
          : community.seedIds,
    });
  }
  return [...byId.values()];
}
