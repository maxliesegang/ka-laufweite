import type { Feature, FeatureCollection, Polygon } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { STOP_TYPE_CONFIG } from '../../lib/stop-type-config';
import type { Stop, StopType } from '../../lib/types';
import { walkshedCacheKey, walkshedCacheKeyPrefixForStop } from '../../lib/walkshed/cache-key';
import { haversineMeters } from '../../lib/walkshed/geo';
import { createWalkshedQueryArea, getRadiusBucketMeters } from '../../lib/walkshed/query-area';
import {
  buildWalkshedPolygons,
  loadCachedWalkshedPolygon,
  type WalkshedRequest,
  type WalkshedResult,
} from '../../lib/walkshed/service';
import type { LatLng } from '../../lib/walkshed/types';
import { circlePolygon, emptyPolygonCollection, type PolygonFeature } from './map-geometry';

const FILL_OPACITY = 0.16;
const STROKE_OPACITY = 0.9;
// Batching strategy (see requirement 1): each dequeued primary stop also pulls in
// nearby queued stops so they share one Overpass request and one walking graph.
// The caps below bound the combined query so a zoomed-out view cannot generate an
// enormous request, and keep concurrency modest rather than using more parallel
// requests as the primary optimisation.
/** Hard cap on how many stops one shared request may cover. */
const MAX_STOPS_PER_WALKSHED_BATCH = 48;
/** A neighbour is only collected if within this straight-line distance of the
 *  batch primary, so the batch span stays bounded (<= 2x this value). */
const MAX_DISTANCE_FROM_BATCH_PRIMARY_METERS = 1_600;
/** Prevent batching from growing the fetched network far beyond one request of
 * the same radius. This matters most for small-radius urban walksheds. */
const MAX_WALKSHED_BATCH_AREA_GROWTH_FACTOR = 10;
/** How many shared batch requests may be in flight at once. */
const MAX_CONCURRENT_WALKSHED_BATCHES = 2;
const LOAD_COOLDOWN_MS = 1_000;
const VIEWPORT_SYNC_DEBOUNCE_MS = 120;
const BOUNDS_PADDING = 0.08;
const PLACEHOLDER_FILL_OPACITY = 0.035;
const PLACEHOLDER_STROKE_OPACITY = 0.5;
const POLYGON_SOURCE_ID = 'walkshed-polygons';
const POLYGON_FILL_LAYER_ID = 'walkshed-polygons-fill';
const POLYGON_LINE_LAYER_ID = 'walkshed-polygons-line';
const PLACEHOLDER_SOURCE_ID = 'walkshed-placeholders';
const PLACEHOLDER_FILL_LAYER_ID = 'walkshed-placeholders-fill';
const PLACEHOLDER_LINE_LAYER_ID = 'walkshed-placeholders-line';

export interface WalkshedLoadProgress {
  loaded: number;
  total: number;
  pending: number;
  unavailable: number;
}

/**
 * One in-flight shared batch request. Members can drop out individually (they
 * leave the viewport, move, or are pre-empted by a click) — the shared request
 * is only aborted once its last member has dropped, so obsolete stops never keep
 * a request alive nor cancel one their neighbours still need.
 */
interface ActiveWalkshedBatch {
  controller: AbortController;
  stopIds: Set<string>;
  generation: number;
}

interface OverlayManagerOptions {
  map: MapLibreMap;
  getRadiusMetersForType: (stopType: StopType) => number;
  isEnabled: () => boolean;
  getAllowReasonableStreetCrossings: () => boolean;
  onLoadProgressChange?: (progress: WalkshedLoadProgress) => void;
}

export class WalkshedOverlayManager {
  private readonly map: MapLibreMap;
  private readonly getRadiusMetersForType: (stopType: StopType) => number;
  private readonly isEnabled: () => boolean;
  private readonly getAllowReasonableStreetCrossings: () => boolean;
  private readonly onLoadProgressChange?: (progress: WalkshedLoadProgress) => void;
  private readonly stopsById = new Map<string, Stop>();
  private readonly polygonsByStopId = new Map<string, PolygonFeature>();
  private readonly placeholdersByStopId = new Map<string, PolygonFeature>();
  private readonly queuedStopIds = new Set<string>();
  private readonly activeBatchByStopId = new Map<string, ActiveWalkshedBatch>();
  private readonly activeWalkshedBatches = new Set<ActiveWalkshedBatch>();
  private readonly priorityStopIds = new Set<string>();
  private readonly explicitlyRequestedStopIds = new Set<string>();
  private readonly retryAfterByWalkshedKey = new Map<string, number>();
  private readonly visibleStopIds = new Set<string>();
  private loadGeneration = 0;
  private viewportSyncTimeoutId: number | null = null;
  private loadCooldownTimeoutId: number | null = null;
  private loadCooldownUntil = 0;

  constructor(options: OverlayManagerOptions) {
    this.map = options.map;
    this.getRadiusMetersForType = options.getRadiusMetersForType;
    this.isEnabled = options.isEnabled;
    this.getAllowReasonableStreetCrossings = options.getAllowReasonableStreetCrossings;
    this.onLoadProgressChange = options.onLoadProgressChange;
    this.addMapLayers();
  }

  private addMapLayers(): void {
    this.map.addSource(POLYGON_SOURCE_ID, { type: 'geojson', data: emptyPolygonCollection() });
    this.map.addLayer({
      id: POLYGON_FILL_LAYER_ID,
      type: 'fill',
      source: POLYGON_SOURCE_ID,
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': FILL_OPACITY },
    });
    this.map.addLayer({
      id: POLYGON_LINE_LAYER_ID,
      type: 'line',
      source: POLYGON_SOURCE_ID,
      paint: {
        'line-color': ['get', 'color'],
        'line-opacity': STROKE_OPACITY,
        'line-width': 2,
      },
    });
    this.map.addSource(PLACEHOLDER_SOURCE_ID, { type: 'geojson', data: emptyPolygonCollection() });
    this.map.addLayer({
      id: PLACEHOLDER_FILL_LAYER_ID,
      type: 'fill',
      source: PLACEHOLDER_SOURCE_ID,
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': PLACEHOLDER_FILL_OPACITY },
    });
    this.map.addLayer({
      id: PLACEHOLDER_LINE_LAYER_ID,
      type: 'line',
      source: PLACEHOLDER_SOURCE_ID,
      paint: {
        'line-color': ['get', 'color'],
        'line-opacity': PLACEHOLDER_STROKE_OPACITY,
        'line-width': 1,
        'line-dasharray': [5, 5],
      },
    });
  }

  private updateSource(sourceId: string, features: PolygonFeature[]): void {
    const source = this.map.getSource(sourceId) as GeoJSONSource | undefined;
    const collection: FeatureCollection<Polygon, PolygonFeature['properties']> = {
      type: 'FeatureCollection',
      features,
    };
    source?.setData(collection);
  }

  private updatePolygonSource(): void {
    this.updateSource(POLYGON_SOURCE_ID, [...this.polygonsByStopId.values()]);
  }

  private updatePlaceholderSource(): void {
    this.updateSource(PLACEHOLDER_SOURCE_ID, [...this.placeholdersByStopId.values()]);
  }

  setStops(stops: Stop[]): void {
    this.stopsById.clear();
    for (const stop of stops) this.stopsById.set(stop.id, stop);
    this.clearOverlay();
    this.scheduleViewportSyncIfEnabled();
  }

  addOrUpdateStop(stop: Stop): void {
    this.loadGeneration += 1;
    this.stopsById.set(stop.id, stop);
    this.queuedStopIds.delete(stop.id);
    this.abortStopLoad(stop.id);
    this.removePolygon(stop.id);
    this.removePlaceholderCircle(stop.id);
    this.clearUnavailableWalkshedsForStop(stop.id);
    this.scheduleViewportSyncIfEnabled();
  }

  removeStop(stopId: string): void {
    this.stopsById.delete(stopId);
    this.visibleStopIds.delete(stopId);
    this.queuedStopIds.delete(stopId);
    this.priorityStopIds.delete(stopId);
    this.explicitlyRequestedStopIds.delete(stopId);
    this.abortStopLoad(stopId);
    this.removePolygon(stopId);
    this.removePlaceholderCircle(stopId);
    this.clearUnavailableWalkshedsForStop(stopId);
    this.emitLoadProgress();
  }

  prioritizeStop(stop: Stop): void {
    if (!this.isEnabled()) return;
    this.stopsById.set(stop.id, stop);
    this.explicitlyRequestedStopIds.add(stop.id);
    this.visibleStopIds.add(stop.id);
    for (const loadingStopId of [...this.activeBatchByStopId.keys()]) {
      if (!this.explicitlyRequestedStopIds.has(loadingStopId)) this.abortStopLoad(loadingStopId);
    }
    if (this.queuedStopIds.has(stop.id)) {
      this.priorityStopIds.add(stop.id);
      return;
    }
    if (!this.isStopEligibleForLoad(stop)) return;
    this.priorityStopIds.add(stop.id);
    this.showPlaceholderCircle(stop);
    void this.loadCachedOrEnqueueStops([stop], this.loadGeneration);
  }

  onViewportChanged(): void {
    this.scheduleViewportSyncIfEnabled();
  }

  onSettingsChanged(): void {
    this.clearOverlay();
    this.scheduleViewportSyncIfEnabled();
  }

  onCoverageModeChanged(enabled: boolean): void {
    if (!enabled) this.clearOverlay();
    else this.scheduleViewportSync();
  }

  private getRadiusForStop(stop: Stop): number {
    return this.getRadiusMetersForType(stop.type);
  }

  private getWalkshedKey(stop: Stop, radiusMeters: number): string {
    return walkshedCacheKey(
      stop.id,
      radiusMeters,
      stop.lat,
      stop.lon,
      this.getAllowReasonableStreetCrossings(),
    );
  }

  private isWalkshedUnavailable(stop: Stop, radiusMeters: number): boolean {
    const key = this.getWalkshedKey(stop, radiusMeters);
    const retryAfter = this.retryAfterByWalkshedKey.get(key);
    if (retryAfter === undefined) return false;
    if (retryAfter > Date.now()) return true;
    this.retryAfterByWalkshedKey.delete(key);
    return false;
  }

  private clearUnavailableWalkshedsForStop(stopId: string): void {
    const prefix = walkshedCacheKeyPrefixForStop(stopId);
    for (const key of this.retryAfterByWalkshedKey.keys()) {
      if (key.startsWith(prefix)) this.retryAfterByWalkshedKey.delete(key);
    }
  }

  private isStopWithinBounds(stop: Stop): boolean {
    const bounds = this.map.getBounds();
    const latPadding = (bounds.getNorth() - bounds.getSouth()) * BOUNDS_PADDING;
    const lonPadding = (bounds.getEast() - bounds.getWest()) * BOUNDS_PADDING;
    return (
      stop.lat >= bounds.getSouth() - latPadding &&
      stop.lat <= bounds.getNorth() + latPadding &&
      stop.lon >= bounds.getWest() - lonPadding &&
      stop.lon <= bounds.getEast() + lonPadding
    );
  }

  private scheduleViewportSyncIfEnabled(): void {
    if (this.isEnabled()) this.scheduleViewportSync();
  }

  private scheduleViewportSync(): void {
    this.cancelScheduledViewportSync();
    this.viewportSyncTimeoutId = window.setTimeout(() => {
      this.viewportSyncTimeoutId = null;
      this.syncVisibleWalksheds();
    }, VIEWPORT_SYNC_DEBOUNCE_MS);
  }

  private cancelScheduledViewportSync(): void {
    if (this.viewportSyncTimeoutId === null) return;
    clearTimeout(this.viewportSyncTimeoutId);
    this.viewportSyncTimeoutId = null;
  }

  private clearOverlay(): void {
    this.loadGeneration += 1;
    this.queuedStopIds.clear();
    this.priorityStopIds.clear();
    this.explicitlyRequestedStopIds.clear();
    this.abortAllStopLoads();
    this.cancelScheduledViewportSync();
    this.cancelLoadCooldown();
    this.polygonsByStopId.clear();
    this.placeholdersByStopId.clear();
    this.retryAfterByWalkshedKey.clear();
    this.visibleStopIds.clear();
    this.updatePolygonSource();
    this.updatePlaceholderSource();
    this.emitLoadProgress();
  }

  private abortStopLoad(stopId: string): void {
    const batch = this.activeBatchByStopId.get(stopId);
    if (!batch) return;
    this.activeBatchByStopId.delete(stopId);
    batch.stopIds.delete(stopId);
    // Only cancel the shared request once no member still needs it.
    if (batch.stopIds.size === 0) batch.controller.abort();
  }

  private abortAllStopLoads(): void {
    for (const batch of this.activeWalkshedBatches) batch.controller.abort();
    this.activeWalkshedBatches.clear();
    this.activeBatchByStopId.clear();
  }

  private cancelLoadCooldown(): void {
    if (this.loadCooldownTimeoutId === null) return;
    clearTimeout(this.loadCooldownTimeoutId);
    this.loadCooldownTimeoutId = null;
  }

  private scheduleLoadQueueAfterCooldown(): void {
    this.cancelLoadCooldown();
    const delay = Math.max(0, this.loadCooldownUntil - Date.now());
    this.loadCooldownTimeoutId = window.setTimeout(() => {
      this.loadCooldownTimeoutId = null;
      this.processLoadQueue();
    }, delay);
  }

  private removePolygon(stopId: string, updateSource = true): boolean {
    const removed = this.polygonsByStopId.delete(stopId);
    if (removed && updateSource) this.updatePolygonSource();
    return removed;
  }

  private showPlaceholderCircle(stop: Stop, updateSource = true): boolean {
    if (this.placeholdersByStopId.has(stop.id) || this.polygonsByStopId.has(stop.id)) return false;
    this.placeholdersByStopId.set(
      stop.id,
      circlePolygon(
        stop.id,
        stop.lat,
        stop.lon,
        this.getRadiusForStop(stop),
        STOP_TYPE_CONFIG[stop.type].color,
      ),
    );
    if (updateSource) this.updatePlaceholderSource();
    return true;
  }

  private removePlaceholderCircle(stopId: string, updateSource = true): boolean {
    const removed = this.placeholdersByStopId.delete(stopId);
    if (removed && updateSource) this.updatePlaceholderSource();
    return removed;
  }

  private emitLoadProgress(): void {
    if (!this.onLoadProgressChange) return;
    let loaded = 0;
    let unavailable = 0;
    for (const stopId of this.visibleStopIds) {
      const stop = this.stopsById.get(stopId);
      if (!stop) continue;
      if (this.polygonsByStopId.has(stop.id)) loaded += 1;
      else if (this.isWalkshedUnavailable(stop, this.getRadiusForStop(stop))) unavailable += 1;
    }
    const total = this.visibleStopIds.size;
    this.onLoadProgressChange({
      loaded,
      total,
      unavailable,
      pending: total - loaded - unavailable,
    });
  }

  private isStopEligibleForLoad(stop: Stop): boolean {
    return (
      !this.polygonsByStopId.has(stop.id) &&
      !this.activeBatchByStopId.has(stop.id) &&
      !this.isWalkshedUnavailable(stop, this.getRadiusForStop(stop))
    );
  }

  private canEnqueueStop(stop: Stop): boolean {
    return this.isStopEligibleForLoad(stop) && !this.queuedStopIds.has(stop.id);
  }

  private isWalkshedRequestCurrent(stop: Stop, generation: number, radiusMeters: number): boolean {
    return (
      generation === this.loadGeneration &&
      this.isEnabled() &&
      radiusMeters === this.getRadiusForStop(stop) &&
      this.stopsById.get(stop.id)?.lat === stop.lat &&
      this.stopsById.get(stop.id)?.lon === stop.lon &&
      this.isStopWithinBounds(stop)
    );
  }

  private dequeueNextStopId(): string | null {
    for (const stopId of this.priorityStopIds) {
      if (!this.queuedStopIds.has(stopId)) continue;
      this.priorityStopIds.delete(stopId);
      this.queuedStopIds.delete(stopId);
      return stopId;
    }
    const center = this.map.getCenter();
    let nearestStopId: string | null = null;
    let nearestDistanceScore = Number.POSITIVE_INFINITY;
    for (const stopId of this.queuedStopIds) {
      const stop = this.stopsById.get(stopId);
      if (!stop) continue;
      const latDistance = stop.lat - center.lat;
      const lonDistance = (stop.lon - center.lng) * Math.cos((center.lat * Math.PI) / 180);
      const distanceScore = latDistance * latDistance + lonDistance * lonDistance;
      if (distanceScore < nearestDistanceScore) {
        nearestDistanceScore = distanceScore;
        nearestStopId = stopId;
      }
    }
    if (nearestStopId) this.queuedStopIds.delete(nearestStopId);
    return nearestStopId;
  }

  private syncVisibleWalksheds(): void {
    if (!this.isEnabled()) return;
    const generation = this.loadGeneration;
    const stopsWithinBounds = [...this.stopsById.values()].filter((stop) =>
      this.isStopWithinBounds(stop),
    );
    const targetStopIds = new Set(stopsWithinBounds.map((stop) => stop.id));
    for (const stopId of this.explicitlyRequestedStopIds) {
      const stop = this.stopsById.get(stopId);
      if (stop && this.isStopWithinBounds(stop)) targetStopIds.add(stopId);
      else this.explicitlyRequestedStopIds.delete(stopId);
    }
    const loadableStops: Stop[] = [];
    let polygonsChanged = false;
    let placeholdersChanged = false;
    this.visibleStopIds.clear();
    for (const stop of stopsWithinBounds) {
      if (!targetStopIds.has(stop.id)) continue;
      this.visibleStopIds.add(stop.id);
      if (this.canEnqueueStop(stop)) {
        loadableStops.push(stop);
        placeholdersChanged = this.showPlaceholderCircle(stop, false) || placeholdersChanged;
      }
    }
    for (const stopId of [...this.polygonsByStopId.keys()]) {
      if (!this.visibleStopIds.has(stopId)) {
        polygonsChanged = this.removePolygon(stopId, false) || polygonsChanged;
      }
    }
    for (const stopId of [...this.placeholdersByStopId.keys()]) {
      if (!this.visibleStopIds.has(stopId)) {
        placeholdersChanged = this.removePlaceholderCircle(stopId, false) || placeholdersChanged;
      }
    }
    for (const stopId of [...this.queuedStopIds]) {
      if (!this.visibleStopIds.has(stopId)) {
        this.queuedStopIds.delete(stopId);
        this.priorityStopIds.delete(stopId);
      }
    }
    for (const stopId of [...this.activeBatchByStopId.keys()]) {
      if (!this.visibleStopIds.has(stopId)) this.abortStopLoad(stopId);
    }
    if (polygonsChanged) this.updatePolygonSource();
    if (placeholdersChanged) this.updatePlaceholderSource();
    void this.loadCachedOrEnqueueStops(loadableStops, generation);
    this.emitLoadProgress();
  }

  private async loadCachedOrEnqueueStops(stops: Stop[], generation: number): Promise<void> {
    await Promise.all(stops.map((stop) => this.loadCachedOrEnqueueStop(stop, generation)));
    if (generation === this.loadGeneration) this.processLoadQueue();
  }

  private async loadCachedOrEnqueueStop(stop: Stop, generation: number): Promise<void> {
    const radiusMeters = this.getRadiusForStop(stop);
    const polygon = await loadCachedWalkshedPolygon(
      stop,
      radiusMeters,
      this.getAllowReasonableStreetCrossings(),
    );
    if (
      !this.isWalkshedRequestCurrent(stop, generation, radiusMeters) ||
      !this.canEnqueueStop(stop)
    )
      return;
    if (polygon) this.renderPolygon(stop, polygon, radiusMeters);
    else this.queuedStopIds.add(stop.id);
  }

  /**
   * Take the next primary stop and gather nearby queued stops into one bounded
   * batch. The primary is chosen by {@link dequeueNextStopId} (priority /
   * explicitly-requested stops first), so a clicked stop is never delayed by
   * batching; its neighbours simply ride along on the same shared request.
   */
  private dequeueWalkshedBatch(): Stop[] | null {
    let primary: Stop | undefined;
    while (!primary) {
      const primaryId = this.dequeueNextStopId();
      if (!primaryId) return null;
      const candidate = this.stopsById.get(primaryId);
      if (candidate && this.isStopEligibleForLoad(candidate)) primary = candidate;
    }

    const batch: Stop[] = [primary];
    const primaryPoint: LatLng = [primary.lat, primary.lon];
    const primaryRadius = this.getRadiusForStop(primary);
    const primaryBucket = getRadiusBucketMeters(primaryRadius);
    const primaryArea = createWalkshedQueryArea([
      { lat: primary.lat, lon: primary.lon, radiusMeters: primaryRadius },
    ]);
    const candidates = [...this.queuedStopIds]
      .map((stopId) => {
        const stop = this.stopsById.get(stopId);
        if (!stop || !this.isStopEligibleForLoad(stop)) return null;
        if (getRadiusBucketMeters(this.getRadiusForStop(stop)) !== primaryBucket) return null;
        return {
          stop,
          stopId,
          distanceFromPrimary: haversineMeters(primaryPoint, [stop.lat, stop.lon]),
        };
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
      .sort((a, b) => a.distanceFromPrimary - b.distanceFromPrimary);

    for (const { stop, stopId, distanceFromPrimary } of candidates) {
      if (batch.length >= MAX_STOPS_PER_WALKSHED_BATCH) break;
      if (distanceFromPrimary > MAX_DISTANCE_FROM_BATCH_PRIMARY_METERS) {
        // Too far to share a request without an oversized query — leave it queued
        // so it forms (or joins) a separate batch.
        continue;
      }
      const candidateArea = createWalkshedQueryArea(
        [...batch, stop].map((candidate) => ({
          lat: candidate.lat,
          lon: candidate.lon,
          radiusMeters: this.getRadiusForStop(candidate),
        })),
      );
      if (
        primaryArea &&
        candidateArea &&
        candidateArea.approximateAreaSquareMeters >
          primaryArea.approximateAreaSquareMeters * MAX_WALKSHED_BATCH_AREA_GROWTH_FACTOR
      ) {
        continue;
      }
      batch.push(stop);
      this.queuedStopIds.delete(stopId);
      this.priorityStopIds.delete(stopId);
    }
    return batch;
  }

  private async loadWalkshedBatch(stops: Stop[], generation: number): Promise<void> {
    const controller = new AbortController();
    const batch: ActiveWalkshedBatch = {
      controller,
      stopIds: new Set(stops.map((stop) => stop.id)),
      generation,
    };
    const radiusByStopId = new Map(stops.map((stop) => [stop.id, this.getRadiusForStop(stop)]));
    this.activeWalkshedBatches.add(batch);
    for (const stop of stops) this.activeBatchByStopId.set(stop.id, batch);

    try {
      const requests: WalkshedRequest[] = stops.map((stop) => ({
        stop,
        radiusMeters: radiusByStopId.get(stop.id) ?? this.getRadiusForStop(stop),
      }));
      const results = await buildWalkshedPolygons(
        requests,
        this.getAllowReasonableStreetCrossings(),
        controller.signal,
      );
      this.applyWalkshedBatchResults(batch, stops, results, radiusByStopId);
    } catch (error) {
      console.error('Walkshed batch failed:', error);
    } finally {
      this.activeWalkshedBatches.delete(batch);
      for (const stop of stops) {
        if (this.activeBatchByStopId.get(stop.id) === batch) {
          this.activeBatchByStopId.delete(stop.id);
        }
      }
      if (this.isEnabled()) {
        this.loadCooldownUntil = Date.now() + LOAD_COOLDOWN_MS;
        this.scheduleLoadQueueAfterCooldown();
        this.scheduleViewportSync();
      }
    }
  }

  private applyWalkshedBatchResults(
    batch: ActiveWalkshedBatch,
    stops: Stop[],
    results: Map<string, WalkshedResult>,
    radiusByStopId: Map<string, number>,
  ): void {
    let polygonsChanged = false;
    let placeholdersChanged = false;
    let soonestRetryAfter = Number.POSITIVE_INFINITY;

    for (const stop of stops) {
      if (!batch.stopIds.has(stop.id)) continue;
      const radiusMeters = radiusByStopId.get(stop.id) ?? this.getRadiusForStop(stop);
      // Stale-result protection: a stop that moved or left the viewport while the
      // shared request was in flight is silently dropped without rendering.
      if (!this.isWalkshedRequestCurrent(stop, batch.generation, radiusMeters)) continue;
      const result = results.get(stop.id);
      if (!result || result.status === 'superseded') continue;

      if (result.status === 'unavailable') {
        this.retryAfterByWalkshedKey.set(
          this.getWalkshedKey(stop, radiusMeters),
          result.retryAfter,
        );
        this.priorityStopIds.delete(stop.id);
        placeholdersChanged = this.removePlaceholderCircle(stop.id, false) || placeholdersChanged;
        soonestRetryAfter = Math.min(soonestRetryAfter, result.retryAfter);
        continue;
      }

      placeholdersChanged = this.removePlaceholderCircle(stop.id, false) || placeholdersChanged;
      this.setPolygonFeature(stop, result.polygon, radiusMeters);
      polygonsChanged = true;
    }

    // One GeoJSONSource.setData per logical batch update (see requirement 6).
    if (polygonsChanged) this.updatePolygonSource();
    if (placeholdersChanged) this.updatePlaceholderSource();
    this.emitLoadProgress();

    if (Number.isFinite(soonestRetryAfter)) {
      const delay = Math.max(0, soonestRetryAfter - Date.now());
      window.setTimeout(() => {
        if (this.isEnabled() && batch.generation === this.loadGeneration) {
          this.scheduleViewportSync();
        }
      }, delay);
    }
  }

  private renderPolygon(stop: Stop, polygon: LatLng[], radiusMeters: number): void {
    const placeholderRemoved = this.removePlaceholderCircle(stop.id, false);
    this.setPolygonFeature(stop, polygon, radiusMeters);
    this.updatePolygonSource();
    if (placeholderRemoved) this.updatePlaceholderSource();
    this.emitLoadProgress();
  }

  /**
   * Mutate the in-memory polygon feature for one stop without touching any
   * GeoJSON source, so a batch can flush every feature with a single setData.
   */
  private setPolygonFeature(stop: Stop, polygon: LatLng[], radiusMeters: number): void {
    this.retryAfterByWalkshedKey.delete(this.getWalkshedKey(stop, radiusMeters));
    this.priorityStopIds.delete(stop.id);
    const coordinates = polygon.map(([lat, lon]): [number, number] => [lon, lat]);
    if (coordinates.length > 0) coordinates.push(coordinates[0]);
    const feature: Feature<Polygon, PolygonFeature['properties']> = {
      type: 'Feature',
      properties: { stopId: stop.id, color: STOP_TYPE_CONFIG[stop.type].color },
      geometry: { type: 'Polygon', coordinates: [coordinates] },
    };
    this.polygonsByStopId.set(stop.id, feature);
  }

  private processLoadQueue(): void {
    if (!this.isEnabled()) return;
    if (Date.now() < this.loadCooldownUntil) {
      this.scheduleLoadQueueAfterCooldown();
      return;
    }
    while (this.activeWalkshedBatches.size < MAX_CONCURRENT_WALKSHED_BATCHES) {
      const batch = this.dequeueWalkshedBatch();
      if (!batch) return;
      void this.loadWalkshedBatch(batch, this.loadGeneration);
    }
  }
}
