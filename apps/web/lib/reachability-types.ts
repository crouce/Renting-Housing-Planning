import type { DirectionStatus } from './reachability-core';

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
  farthestRouteId: string | null;
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
