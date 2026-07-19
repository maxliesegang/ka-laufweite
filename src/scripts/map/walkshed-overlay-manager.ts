import L from 'leaflet';
import { STOP_TYPE_CONFIG } from '../../lib/stop-type-config';
import type { Stop, StopType } from '../../lib/types';
import { walkshedCacheKey, walkshedCacheKeyPrefixForStop } from '../../lib/walkshed/cache-key';
import { buildWalkshedPolygon, peekCachedWalkshedPolygon } from '../../lib/walkshed/service';

const FILL_OPACITY = 0.16;
const STROKE_OPACITY = 0.9;
const MAX_CONCURRENT_LOADS = 4;
const VIEWPORT_SYNC_DEBOUNCE_MS = 120;
const BOUNDS_PADDING = 0.08;
const PLACEHOLDER_FILL_OPACITY = 0.035;
const PLACEHOLDER_STROKE_OPACITY = 0.5;

export interface WalkshedLoadProgress {
  loaded: number;
  total: number;
  pending: number;
  unavailable: number;
}

interface OverlayManagerOptions {
  map: L.Map;
  getRadiusMetersForType: (stopType: StopType) => number;
  isEnabled: () => boolean;
  paneName?: string;
  onLoadProgressChange?: (progress: WalkshedLoadProgress) => void;
}

export class WalkshedOverlayManager {
  private readonly map: L.Map;
  private readonly getRadiusMetersForType: (stopType: StopType) => number;
  private readonly isEnabled: () => boolean;
  private readonly paneName?: string;
  private readonly onLoadProgressChange?: (progress: WalkshedLoadProgress) => void;
  private readonly overlayLayerGroup: L.LayerGroup;

  private readonly stopsById = new Map<string, Stop>();
  private readonly polygonsByStopId = new Map<string, L.Polygon>();
  private readonly placeholderCirclesByStopId = new Map<string, L.Circle>();
  private readonly queuedStopIds = new Set<string>();
  private readonly loadingStopIds = new Set<string>();
  private readonly priorityStopIds = new Set<string>();
  private readonly unavailableWalkshedKeys = new Set<string>();
  private readonly visibleStopIds = new Set<string>();

  private loadGeneration = 0;
  private viewportSyncTimeoutId: number | null = null;
  private activeLoadCount = 0;

  constructor(options: OverlayManagerOptions) {
    this.map = options.map;
    this.getRadiusMetersForType = options.getRadiusMetersForType;
    this.isEnabled = options.isEnabled;
    this.paneName = options.paneName;
    this.onLoadProgressChange = options.onLoadProgressChange;
    this.overlayLayerGroup = L.layerGroup().addTo(this.map);
  }

  setStops(stops: Stop[]): void {
    this.stopsById.clear();
    for (const stop of stops) {
      this.stopsById.set(stop.id, stop);
    }

    this.clearOverlay();
    this.scheduleViewportSyncIfEnabled();
  }

  addOrUpdateStop(stop: Stop): void {
    this.stopsById.set(stop.id, stop);
    this.scheduleViewportSyncIfEnabled();
  }

  removeStop(stopId: string): void {
    this.stopsById.delete(stopId);
    this.visibleStopIds.delete(stopId);
    this.queuedStopIds.delete(stopId);
    this.loadingStopIds.delete(stopId);
    this.priorityStopIds.delete(stopId);
    this.removePolygon(stopId);
    this.removePlaceholderCircle(stopId);
    this.removeUnavailableWalkshedKeysForStop(stopId);
    this.emitLoadProgress();
  }

  prioritizeStop(stop: Stop): void {
    if (!this.isEnabled()) return;

    this.stopsById.set(stop.id, stop);
    if (this.queuedStopIds.has(stop.id)) {
      this.priorityStopIds.add(stop.id);
      return;
    }
    if (!this.isStopEligibleForLoad(stop)) return;

    this.priorityStopIds.add(stop.id);
    this.showPlaceholderCircle(stop);
    void this.renderCachedOrEnqueueStops([stop], this.loadGeneration);
  }

  onViewportChanged(): void {
    this.scheduleViewportSyncIfEnabled();
  }

  onSettingsChanged(): void {
    this.clearOverlay();
    this.scheduleViewportSyncIfEnabled();
  }

  onCoverageModeChanged(enabled: boolean): void {
    if (!enabled) {
      this.clearOverlay();
      return;
    }

    this.scheduleViewportSync();
  }

  private walkshedKey(stopId: string, radiusMeters: number): string {
    return walkshedCacheKey(stopId, radiusMeters);
  }

  private isWalkshedUnavailable(stopId: string, radiusMeters: number): boolean {
    return this.unavailableWalkshedKeys.has(this.walkshedKey(stopId, radiusMeters));
  }

  private removeUnavailableWalkshedKeysForStop(stopId: string): void {
    const prefix = walkshedCacheKeyPrefixForStop(stopId);
    for (const key of [...this.unavailableWalkshedKeys]) {
      if (key.startsWith(prefix)) {
        this.unavailableWalkshedKeys.delete(key);
      }
    }
  }

  private paddedViewportBounds(): L.LatLngBounds {
    return this.map.getBounds().pad(BOUNDS_PADDING);
  }

  private isStopWithinBounds(stop: Stop, bounds = this.paddedViewportBounds()): boolean {
    return bounds.contains([stop.lat, stop.lon]);
  }

  private scheduleViewportSyncIfEnabled(): void {
    if (this.isEnabled()) {
      this.scheduleViewportSync();
    }
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
    this.cancelScheduledViewportSync();
    this.overlayLayerGroup.clearLayers();
    this.polygonsByStopId.clear();
    this.placeholderCirclesByStopId.clear();
    this.unavailableWalkshedKeys.clear();
    this.visibleStopIds.clear();
    this.emitLoadProgress();
  }

  private removePolygon(stopId: string): void {
    const polygon = this.polygonsByStopId.get(stopId);
    if (!polygon) return;

    this.overlayLayerGroup.removeLayer(polygon);
    this.polygonsByStopId.delete(stopId);
  }

  private showPlaceholderCircle(stop: Stop): void {
    if (this.placeholderCirclesByStopId.has(stop.id) || this.polygonsByStopId.has(stop.id)) return;

    const color = STOP_TYPE_CONFIG[stop.type].color;
    const placeholderCircle = L.circle([stop.lat, stop.lon], {
      radius: this.radiusForStop(stop),
      color,
      fillColor: color,
      fillOpacity: PLACEHOLDER_FILL_OPACITY,
      opacity: PLACEHOLDER_STROKE_OPACITY,
      weight: 1,
      dashArray: '5 5',
      interactive: false,
      pane: this.paneName,
    });
    this.placeholderCirclesByStopId.set(stop.id, placeholderCircle);
    this.overlayLayerGroup.addLayer(placeholderCircle);
  }

  private removePlaceholderCircle(stopId: string): void {
    const placeholderCircle = this.placeholderCirclesByStopId.get(stopId);
    if (!placeholderCircle) return;
    this.overlayLayerGroup.removeLayer(placeholderCircle);
    this.placeholderCirclesByStopId.delete(stopId);
  }

  private emitLoadProgress(): void {
    if (!this.onLoadProgressChange) return;

    let loaded = 0;
    let unavailable = 0;
    for (const stopId of this.visibleStopIds) {
      const stop = this.stopsById.get(stopId);
      if (!stop) continue;
      if (this.polygonsByStopId.has(stop.id)) loaded += 1;
      else if (this.isWalkshedUnavailable(stop.id, this.radiusForStop(stop))) unavailable += 1;
    }

    const total = this.visibleStopIds.size;
    this.onLoadProgressChange({
      loaded,
      total,
      unavailable,
      pending: total - loaded - unavailable,
    });
  }

  private radiusForStop(stop: Stop): number {
    return this.getRadiusMetersForType(stop.type);
  }

  /**
   * A stop is eligible for (re)queuing only if it has no rendered layer yet,
   * is not already being loaded, and is not currently marked unavailable.
   */
  private isStopEligibleForLoad(stop: Stop): boolean {
    return (
      !this.polygonsByStopId.has(stop.id) &&
      !this.loadingStopIds.has(stop.id) &&
      !this.isWalkshedUnavailable(stop.id, this.radiusForStop(stop))
    );
  }

  private canEnqueueStop(stop: Stop): boolean {
    return this.isStopEligibleForLoad(stop) && !this.queuedStopIds.has(stop.id);
  }

  /**
   * After an await, a resolved polygon is only worth rendering if the load generation,
   * settings, radius, stop set, and viewport still match what was captured when
   * the work started. Shared by both the cached pre-pass and the network worker.
   */
  private isLoadResultCurrent(stop: Stop, generation: number, radiusMeters: number): boolean {
    return (
      generation === this.loadGeneration &&
      this.isEnabled() &&
      radiusMeters === this.radiusForStop(stop) &&
      this.stopsById.has(stop.id) &&
      this.isStopWithinBounds(stop)
    );
  }

  private dequeueNextStopId(): string | null {
    if (this.queuedStopIds.size === 0) return null;

    for (const stopId of this.priorityStopIds) {
      if (!this.queuedStopIds.has(stopId)) continue;
      this.priorityStopIds.delete(stopId);
      this.queuedStopIds.delete(stopId);
      return stopId;
    }

    const center = this.map.getCenter();
    let nearestStopId: string | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const stopId of this.queuedStopIds) {
      const stop = this.stopsById.get(stopId);
      if (!stop) continue;
      const distance = center.distanceTo([stop.lat, stop.lon]);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestStopId = stopId;
      }
    }

    if (nearestStopId) this.queuedStopIds.delete(nearestStopId);
    return nearestStopId;
  }

  private scheduleViewportSync(): void {
    this.cancelScheduledViewportSync();
    this.viewportSyncTimeoutId = window.setTimeout(() => {
      this.viewportSyncTimeoutId = null;
      this.syncVisibleWalksheds();
    }, VIEWPORT_SYNC_DEBOUNCE_MS);
  }

  private syncVisibleWalksheds(): void {
    if (!this.isEnabled()) return;

    const generation = this.loadGeneration;
    const bounds = this.paddedViewportBounds();
    const loadableStops: Stop[] = [];
    this.visibleStopIds.clear();

    for (const stop of this.stopsById.values()) {
      if (!this.isStopWithinBounds(stop, bounds)) continue;
      this.visibleStopIds.add(stop.id);
      if (this.canEnqueueStop(stop)) {
        loadableStops.push(stop);
        this.showPlaceholderCircle(stop);
      }
    }

    for (const stopId of [...this.polygonsByStopId.keys()]) {
      if (!this.visibleStopIds.has(stopId)) {
        this.removePolygon(stopId);
      }
    }

    for (const stopId of [...this.placeholderCirclesByStopId.keys()]) {
      if (!this.visibleStopIds.has(stopId)) this.removePlaceholderCircle(stopId);
    }

    for (const stopId of [...this.queuedStopIds]) {
      if (!this.visibleStopIds.has(stopId)) {
        this.queuedStopIds.delete(stopId);
        this.priorityStopIds.delete(stopId);
      }
    }

    void this.renderCachedOrEnqueueStops(loadableStops, generation);
    this.emitLoadProgress();
  }

  /**
   * Fast pre-pass: render every stop that already has a cached polygon without
   * consuming a network worker slot, then enqueue only the genuine misses for the
   * bounded-concurrency Overpass compute. This prevents cached stops from being
   * blocked behind uncached neighbours that are still fetching from the network.
   */
  private async renderCachedOrEnqueueStops(stops: Stop[], generation: number): Promise<void> {
    await Promise.all(stops.map((stop) => this.renderCachedOrEnqueue(stop, generation)));

    if (generation !== this.loadGeneration) return;
    this.processLoadQueue();
  }

  private async renderCachedOrEnqueue(stop: Stop, generation: number): Promise<void> {
    const radiusMeters = this.radiusForStop(stop);
    const polygon = await peekCachedWalkshedPolygon(stop, radiusMeters);

    if (!this.isLoadResultCurrent(stop, generation, radiusMeters)) return;
    if (!this.canEnqueueStop(stop)) return;

    if (polygon) {
      this.renderPolygon(stop, polygon, radiusMeters);
      return;
    }

    this.queuedStopIds.add(stop.id);
  }

  private async loadWalkshedForStop(
    stop: Stop,
    generation: number,
    radiusMeters: number,
  ): Promise<void> {
    const polygon = await buildWalkshedPolygon(stop, radiusMeters);

    if (!this.isLoadResultCurrent(stop, generation, radiusMeters)) return;

    if (!polygon) {
      this.unavailableWalkshedKeys.add(this.walkshedKey(stop.id, radiusMeters));
      this.priorityStopIds.delete(stop.id);
      this.removePlaceholderCircle(stop.id);
      this.emitLoadProgress();
      return;
    }

    this.renderPolygon(stop, polygon, radiusMeters);
  }

  private renderPolygon(stop: Stop, polygon: L.LatLngExpression[], radiusMeters: number): void {
    this.unavailableWalkshedKeys.delete(this.walkshedKey(stop.id, radiusMeters));
    this.priorityStopIds.delete(stop.id);
    this.removePolygon(stop.id);
    this.removePlaceholderCircle(stop.id);

    const color = STOP_TYPE_CONFIG[stop.type].color;
    const polygonLayer = L.polygon(polygon, {
      color,
      fillColor: color,
      fillOpacity: FILL_OPACITY,
      opacity: STROKE_OPACITY,
      weight: 2,
      interactive: false,
      pane: this.paneName,
    });

    this.polygonsByStopId.set(stop.id, polygonLayer);
    this.overlayLayerGroup.addLayer(polygonLayer);
    this.emitLoadProgress();
  }

  private processLoadQueue(): void {
    if (!this.isEnabled()) return;

    while (this.activeLoadCount < MAX_CONCURRENT_LOADS) {
      const stopId = this.dequeueNextStopId();
      if (!stopId) return;

      const stop = this.stopsById.get(stopId);
      if (!stop || !this.isStopEligibleForLoad(stop)) continue;

      const radiusMeters = this.radiusForStop(stop);
      const generation = this.loadGeneration;
      this.activeLoadCount += 1;
      this.loadingStopIds.add(stopId);

      void this.loadWalkshedForStop(stop, generation, radiusMeters)
        .catch((error) => console.error(`Walkshed failed for ${stopId}:`, error))
        .finally(() => {
          this.activeLoadCount = Math.max(0, this.activeLoadCount - 1);
          this.loadingStopIds.delete(stopId);
          if (this.isEnabled()) {
            this.processLoadQueue();
            this.scheduleViewportSync();
          }
        });
    }
  }
}
