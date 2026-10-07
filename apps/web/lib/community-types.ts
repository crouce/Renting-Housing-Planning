export type TransitStop = {
  id: string;
  name: string;
  location: string;
  originalLocation?: string;
};
export type BoardingStation = {
  id: string;
  directionId: string;
  station: TransitStop;
  accessStation: TransitStop;
  citycode: string;
  lineId: string;
  lineName: string;
  directionLabel: string;
  stops: TransitStop[];
  transitSeconds: number;
  companyWalkSeconds: number;
};
export type Community = TransitStop & {
  address: string;
  distanceMeters: number;
  seedIds: string[];
};
export type CommunitySearch = {
  communities: Community[];
  hasMore: boolean;
  page: number;
  cached: boolean;
  checkedAt?: number;
};
export type CommunityGeometry = {
  mode: 'WALK' | 'TRANSIT';
  path: Array<[number, number]>;
  stops: Array<TransitStop & { role: 'BOARD' | 'VIA' | 'ALIGHT' }>;
};
export type CommunityVerification = {
  communityId: string;
  seedId: string;
  status: 'reachable' | 'over_budget' | 'no_route' | 'error';
  totalSeconds?: number;
  homeWalkSeconds?: number;
  transitSeconds?: number;
  companyWalkSeconds?: number;
  walkingMeters?: number;
  geometry: CommunityGeometry[];
  message?: string;
  checkedAt: number;
  cached: boolean;
};
