import type { WalkshedCalculationRequest, WalkshedCalculationResult } from './polygon-calculation';
import type {
  WalkshedCalculationWorkerRequest,
  WalkshedCalculationWorkerResponse,
} from './polygon-calculation-worker-protocol';
import type { OverpassResponse } from './types';

interface PendingWorkerRequest {
  resolve: (response: WalkshedCalculationWorkerResponse) => void;
  reject: (error: unknown) => void;
}

let worker: Worker | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<number, PendingWorkerRequest>();
const cachedWorkerGraphKeys = new Set<string>();

export function isWalkshedCalculationWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}

function rejectPendingRequests(error: unknown): void {
  for (const pending of pendingRequests.values()) pending.reject(error);
  pendingRequests.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./polygon-calculation-worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = ({ data }: MessageEvent<WalkshedCalculationWorkerResponse>) => {
    const pending = pendingRequests.get(data.requestId);
    if (!pending) return;
    pendingRequests.delete(data.requestId);
    for (const key of data.evictedWalkGraphKeys) cachedWorkerGraphKeys.delete(key);
    if (data.results) cachedWorkerGraphKeys.add(data.walkGraphKey);
    pending.resolve(data);
  };
  worker.onerror = (event) => {
    rejectPendingRequests(event.error ?? new Error(event.message));
    worker?.terminate();
    worker = null;
    cachedWorkerGraphKeys.clear();
  };
  return worker;
}

function requestWorkerCalculation(
  walkGraphKey: string,
  networkData: OverpassResponse | undefined,
  allowReasonableStreetCrossings: boolean,
  requests: WalkshedCalculationRequest[],
  signal?: AbortSignal,
): Promise<WalkshedCalculationWorkerResponse> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const requestId = nextRequestId;
  nextRequestId += 1;

  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      pendingRequests.delete(requestId);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
    pendingRequests.set(requestId, {
      resolve: (workerResponse) => {
        signal?.removeEventListener('abort', handleAbort);
        resolve(workerResponse);
      },
      reject: (error) => {
        signal?.removeEventListener('abort', handleAbort);
        reject(error);
      },
    });
    const request: WalkshedCalculationWorkerRequest = {
      type: 'calculate',
      requestId,
      walkGraphKey,
      allowReasonableStreetCrossings,
      networkData,
      requests,
    };
    try {
      getWorker().postMessage(request);
    } catch (error) {
      pendingRequests.delete(requestId);
      signal?.removeEventListener('abort', handleAbort);
      reject(error);
    }
  });
}

export async function calculateWalkshedPolygonsInWorker(
  walkGraphKey: string,
  networkData: OverpassResponse,
  allowReasonableStreetCrossings: boolean,
  requests: WalkshedCalculationRequest[],
  signal?: AbortSignal,
): Promise<WalkshedCalculationResult[] | null> {
  const firstResponse = await requestWorkerCalculation(
    walkGraphKey,
    cachedWorkerGraphKeys.has(walkGraphKey) ? undefined : networkData,
    allowReasonableStreetCrossings,
    requests,
    signal,
  );
  if (firstResponse.error === 'graph-missing') {
    const retryResponse = await requestWorkerCalculation(
      walkGraphKey,
      networkData,
      allowReasonableStreetCrossings,
      requests,
      signal,
    );
    return retryResponse.results ?? null;
  }
  return firstResponse.results ?? null;
}

export function resetWalkshedCalculationWorker(): void {
  rejectPendingRequests(new Error('Walkshed calculation cache cleared'));
  worker?.terminate();
  worker = null;
  cachedWorkerGraphKeys.clear();
}
