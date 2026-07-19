import { MAX_CACHED_WALK_GRAPH_NODES, MAX_WALKSHED_AREA_CACHE_ENTRIES } from './constants';
import { calculateWalkshedPolygons } from './polygon-calculation';
import type {
  WalkshedCalculationWorkerRequest,
  WalkshedCalculationWorkerResponse,
} from './polygon-calculation-worker-protocol';
import { buildWalkGraph } from './graph';
import type { WalkGraph } from './types';
import { WeightedLruCache } from './weighted-lru-cache';

const graphs = new WeightedLruCache<string, WalkGraph>(
  MAX_WALKSHED_AREA_CACHE_ENTRIES,
  MAX_CACHED_WALK_GRAPH_NODES,
);

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WalkshedCalculationWorkerRequest>) => void) | null;
  postMessage: (message: WalkshedCalculationWorkerResponse) => void;
};

workerScope.onmessage = ({ data }) => {
  if (data.type !== 'calculate') return;
  let graph = graphs.get(data.walkGraphKey);
  let evictedWalkGraphKeys: string[] = [];

  if (!graph) {
    if (!data.networkData) {
      workerScope.postMessage({
        type: 'result',
        requestId: data.requestId,
        walkGraphKey: data.walkGraphKey,
        evictedWalkGraphKeys,
        error: 'graph-missing',
      });
      return;
    }
    graph = buildWalkGraph(data.networkData, data.allowReasonableStreetCrossings) ?? undefined;
    if (!graph) {
      workerScope.postMessage({
        type: 'result',
        requestId: data.requestId,
        walkGraphKey: data.walkGraphKey,
        evictedWalkGraphKeys,
        error: 'no-data',
      });
      return;
    }
    evictedWalkGraphKeys = graphs.set(data.walkGraphKey, graph, graph.nodes.length);
  }

  try {
    workerScope.postMessage({
      type: 'result',
      requestId: data.requestId,
      walkGraphKey: data.walkGraphKey,
      evictedWalkGraphKeys,
      results: calculateWalkshedPolygons(graph, data.requests),
    });
  } catch (error) {
    console.error('Walkshed worker calculation failed:', error);
    workerScope.postMessage({
      type: 'result',
      requestId: data.requestId,
      walkGraphKey: data.walkGraphKey,
      evictedWalkGraphKeys,
      error: 'calculation-failed',
    });
  }
};
