import type { DirectionStatus } from './reachability-core';
import type { BoardingStation } from './community-types';

export type DirectionSummary = {
  id: string;
  lineName: string;
  directionLabel: string;
  startStopName: string;
  endStopName: string;
  candidateCount: number;
  routeCheckCount: number;
  checkedCount: number;
  status: DirectionStatus;
  boundaryConfirmed: boolean;
  pendingCount: number;
  errorCount: number;
  noRouteCount: number;
  cached: boolean;
  checkedAt?: number;
  reusedCheckCount?: number;
  farthestRouteId: string | null;
  boardingStations: BoardingStation[];
  evidence: Array<{
    stationName: string;
    status: DirectionStatus;
    durationMinutes?: number;
    durationSeconds?: number;
    errorCode?: string;
  }>;
};

export type CalculationIssue = {
  id: string;
  accessStationId: string;
  accessStationName: string;
  lineName?: string;
  message: string;
};
