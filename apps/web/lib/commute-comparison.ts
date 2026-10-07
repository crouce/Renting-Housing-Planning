import { communityRouteKey, isRecent } from './cache-policy.ts';
import { validDepartureDate } from './departure-date.ts';
import { validSeed, validStop } from './community-core.ts';
import type {
  BoardingStation,
  Community,
  CommunityVerification,
  TransitStop,
} from './community-types';
export type ComparisonTask = {
  key: string;
  community: Community;
  anchor: TransitStop;
  seed: BoardingStation;
  date: string;
  time: string;
};
export function comparisonTask(
  community: Community,
  anchor: TransitStop,
  seed: BoardingStation,
  date: string,
  time: string,
): ComparisonTask {
  return {
    key: communityRouteKey(community, anchor, seed, date, time),
    community,
    anchor,
    seed,
    date,
    time,
  };
}
export function freshComparison(
  result?: CommunityVerification,
  now = Date.now(),
) {
  return (
    !!result &&
    isRecent(result.checkedAt, now) &&
    ['reachable', 'over_budget'].includes(result.status) &&
    Number.isFinite(result.totalSeconds) &&
    result.totalSeconds! >= 0
  );
}
export function comparisonWinners(
  rows: Array<{ key: string; result?: CommunityVerification }>,
  now = Date.now(),
) {
  const valid = rows.filter((row) => freshComparison(row.result, now));
  const shortest = Math.min(...valid.map((row) => row.result!.totalSeconds!));
  const walking = valid.filter(({ result }) =>
    [result!.homeWalkSeconds, result!.companyWalkSeconds].every(
      (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
    ),
  );
  const least = Math.min(
    ...walking.map(
      ({ result }) => result!.homeWalkSeconds! + result!.companyWalkSeconds!,
    ),
  );
  return {
    fastest: valid
      .filter((row) => row.result!.totalSeconds === shortest)
      .map((row) => row.key),
    leastWalking: walking
      .filter(
        ({ result }) =>
          result!.homeWalkSeconds! + result!.companyWalkSeconds! === least,
      )
      .map((row) => row.key),
  };
}
export async function runComparison(
  tasks: ComparisonTask[],
  budget: number,
  signal: AbortSignal,
  known: Record<string, CommunityVerification>,
  onResult: (task: ComparisonTask, result: CommunityVerification) => void,
  request: (
    task: ComparisonTask,
    signal: AbortSignal,
  ) => Promise<CommunityVerification>,
) {
  if (
    tasks.length < 2 ||
    tasks.length > 3 ||
    new Set(tasks.map((t) => t.key)).size !== tasks.length ||
    tasks.some(
      (t) =>
        !validStop(t.community) ||
        !validStop(t.anchor) ||
        !validSeed(t.seed) ||
        !validDepartureDate(t.date) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(t.time),
    ) ||
    budget < 20 ||
    budget > 90
  )
    throw new Error('请选择 2～3 个不同的有效方案。');
  let requested = 0,
    reused = 0,
    failed = 0;
  for (const task of tasks) {
    if (signal.aborted) break;
    let result = known[task.key];
    if (freshComparison(result)) reused++;
    else {
      requested++;
      try {
        result = await request(task, signal);
      } catch (e) {
        if (signal.aborted) break;
        result = {
          communityId: task.community.id,
          seedId: task.seed.id,
          status: 'error',
          checkedAt: Date.now(),
          cached: false,
          geometry: [],
          message: e instanceof Error ? e.message : '核验失败',
        };
      }
    }
    if (signal.aborted) break;
    if (result.status === 'error' || result.status === 'no_route') failed++;
    onResult(task, result);
  }
  return { requested, reused, failed };
}
