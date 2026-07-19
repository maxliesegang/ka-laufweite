import type { WalkshedCalculationRequest, WalkshedCalculationResult } from './polygon-calculation';
import type { OverpassResponse } from './types';

export interface WalkshedCalculationWorkerRequest {
  type: 'calculate';
  requestId: number;
  walkGraphKey: string;
  allowReasonableStreetCrossings: boolean;
  networkData?: OverpassResponse;
  requests: WalkshedCalculationRequest[];
}

export interface WalkshedCalculationWorkerResponse {
  type: 'result';
  requestId: number;
  walkGraphKey: string;
  evictedWalkGraphKeys: string[];
  results?: WalkshedCalculationResult[];
  error?: 'graph-missing' | 'no-data' | 'calculation-failed';
}
