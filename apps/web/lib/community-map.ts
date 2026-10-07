import type {
  Community,
  CommunityVerification,
  TransitStop,
} from './community-types';

export type CommunityPinState = {
  status: 'reachable' | 'over_budget' | 'pending';
  favorite: boolean;
};
export type CommunityMapSelection = {
  communities: Community[];
  activeId?: string;
  verification?: CommunityVerification;
  states?: Record<string, CommunityPinState>;
  onSelect?: (id: string) => void;
  onClear?: () => void;
  focus?: boolean;
  source?: 'explorer' | 'favorites';
  anchor?: TransitStop;
};
export function pinLabel(state?: CommunityPinState) {
  return `${state?.favorite ? '已收藏 · ' : ''}${state?.status === 'reachable' ? '预算内' : state?.status === 'over_budget' ? '超预算' : '待核验'}`;
}
// Web-Mercator screen distance for the current 2D zoom. No map/API query.
export function overlappingCommunities(
  items: Community[],
  target: Community,
  zoom: number,
) {
  const project = (location: string) => {
    const [lng, lat] = location.split(',').map(Number);
    const sin = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
    const scale = 256 * 2 ** zoom;
    return [
      ((lng + 180) / 360) * scale,
      (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
    ];
  };
  const [x, y] = project(target.location);
  return items.filter((item) => {
    const [a, b] = project(item.location);
    return Math.hypot(a - x, b - y) <= 38;
  });
}
