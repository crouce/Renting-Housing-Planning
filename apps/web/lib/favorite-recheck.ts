import { validSeed } from './community-core.ts';
import { validDepartureDate } from './departure-date.ts';
import type { Favorite } from './community-collection';
import type { BoardingStation, TransitStop } from './community-types';

export function favoriteSeed(item: Favorite, available: BoardingStation[]) {
  const matches = (seed: BoardingStation) =>
    validSeed(seed) &&
    seed.lineName === item.route.lineName &&
    seed.directionLabel === item.route.directionLabel &&
    seed.station.name === item.route.boarding &&
    seed.stops.at(-1)?.name === item.route.alighting &&
    (!item.verification || seed.id === item.verification.seedId);
  if (item.seed && matches(item.seed)) return item.seed;
  const candidates = available.filter(matches);
  return candidates.length === 1 ? candidates[0] : undefined;
}
export function favoriteRecheckIssue(
  item: Favorite,
  anchor: TransitStop | null,
  date: string,
  time: string,
  available: BoardingStation[],
) {
  if (
    !anchor ||
    item.anchor.id !== anchor.id ||
    item.anchor.location !== anchor.location
  )
    return '请先切换到收藏时的工作地点，不能把旧线路套用到另一家公司。';
  if (!validDepartureDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    return '请先确认有效的出发日期和时间。';
  if (!favoriteSeed(item, available))
    return '旧收藏缺少完整线路信息，请在小区列表更新收藏后重试。';
  return '';
}
