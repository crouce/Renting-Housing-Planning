import type { Community, CommunityVerification } from './community-types';

export const COMMUNITY_BATCH_LIMIT = 5;
export type WalkingLimits = { homeMinutes: number; totalMinutes: number };
export type WalkingStatus = 'unlimited' | 'match' | 'over' | 'pending';

export function walkingStatus(
  result: CommunityVerification | undefined,
  limits: WalkingLimits,
  now = Date.now(),
): WalkingStatus {
  if (!limits.homeMinutes && !limits.totalMinutes) return 'unlimited';
  if (
    !result ||
    !['reachable', 'over_budget'].includes(result.status) ||
    result.checkedAt > now ||
    now - result.checkedAt >= 600_000
  )
    return 'pending';
  const valid = (n: unknown): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const home = result.homeWalkSeconds,
    company = result.companyWalkSeconds;
  if (limits.homeMinutes && valid(home) && home > limits.homeMinutes * 60)
    return 'over';
  if (
    limits.totalMinutes &&
    valid(home) &&
    valid(company) &&
    home + company > limits.totalMinutes * 60
  )
    return 'over';
  if (
    (limits.homeMinutes && !valid(home)) ||
    (limits.totalMinutes && (!valid(home) || !valid(company)))
  )
    return 'pending';
  return 'match';
}

// Only explicitly selected, visible and considered POIs may consume batch quota.
export function selectedVerificationBatch(
  visible: Community[],
  checked: string[],
  needsCheck: (item: Community) => boolean,
) {
  const selected = new Set(checked);
  return visible
    .filter((item) => selected.has(item.id) && needsCheck(item))
    .slice(0, COMMUNITY_BATCH_LIMIT);
}
export function toggleCommunitySelection(
  current: string[],
  id: string,
  checked: boolean,
) {
  if (!checked) return current.filter((item) => item !== id);
  return current.includes(id) || current.length >= COMMUNITY_BATCH_LIMIT
    ? current
    : [...current, id];
}
