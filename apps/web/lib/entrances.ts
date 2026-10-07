import { validLocation } from './community-core.ts';
import type { TransitStop } from './community-types';

export type EntranceKind = 'company' | 'community';
export type Entrance = {
  kind: EntranceKind;
  id: string;
  name: string;
  originalLocation: string;
  location: string;
};
export const ENTRANCE_LIMIT = 40;
export const NO_ENTRANCES: Entrance[] = [];
export const entranceKey = (
  item: Pick<Entrance, 'kind' | 'id' | 'originalLocation'>,
) => JSON.stringify([item.kind, item.id, item.originalLocation]);
export function validEntrance(value: unknown): value is Entrance {
  const e = value as Entrance;
  return Boolean(
    e &&
    ['company', 'community'].includes(e.kind) &&
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    e.id.length <= 160 &&
    typeof e.name === 'string' &&
    e.name.length <= 160 &&
    validLocation(e.location) &&
    validLocation(e.originalLocation) &&
    entranceDistance(e.location, e.originalLocation) <= 3000,
  );
}
export function entranceDistance(a: string, b: string) {
  const [x, y] = a.split(',').map(Number),
    [xx, yy] = b.split(',').map(Number);
  const rad = Math.PI / 180;
  const h =
    Math.sin(((yy - y) * rad) / 2) ** 2 +
    Math.cos(y * rad) *
      Math.cos(yy * rad) *
      Math.sin(((xx - x) * rad) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function applyEntrance<T extends TransitStop>(
  place: T,
  kind: EntranceKind,
  entries: Entrance[],
): T {
  const original = place.originalLocation ?? place.location;
  const entry = entries.find(
    (e) =>
      e.kind === kind && e.id === place.id && e.originalLocation === original,
  );
  return entry
    ? { ...place, originalLocation: original, location: entry.location }
    : { ...place, location: original, originalLocation: undefined };
}
export function changeEntrance(
  entries: Entrance[],
  kind: EntranceKind,
  place: TransitStop,
  location: string,
) {
  const entry = {
    kind,
    id: place.id,
    name: place.name,
    originalLocation: place.originalLocation ?? place.location,
    location,
  };
  if (
    !validEntrance(entry) ||
    entranceDistance(entry.originalLocation, location) > 3000
  )
    throw new Error(
      '入口须为有效高德坐标，且距原位置不超过 3 公里；更远请重新搜索地点。',
    );
  const next = entries.filter((e) => entranceKey(e) !== entranceKey(entry));
  if (location !== entry.originalLocation) next.push(entry);
  if (next.length > ENTRANCE_LIMIT)
    throw new Error('最多保存 40 个入口，请先恢复部分原位置。');
  return next;
}
export type EntranceRequest = {
  kind: EntranceKind;
  place: TransitStop;
  onSave: (location: string) => void;
};
