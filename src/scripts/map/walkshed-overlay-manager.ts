import type { Feature, FeatureCollection, Polygon } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { STOP_TYPE_CONFIG } from '../../lib/stop-type-config';
import type { Stop, StopType } from '../../lib/types';
import { walkshedCacheKey, walkshedCacheKeyPrefixForStop } from '../../lib/walkshed/cache-key';
import { buildWalkshedPolygon, peekCachedWalkshedPolygon } from '../../lib/walkshed/service';
import type { LatLng } from '../../lib/walkshed/types';
import { circlePolygon, emptyPolygonCollection, type PolygonFeature } from './map-geometry';

const FILL_OPACITY = 0.16;
const STROKE_OPACITY = 0.9;
const MAX_CONCURRENT_LOADS = 4;
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
  private readonly loadingStopIds = new Map<string, symbol>();
  private readonly priorityStopIds = new Set<string>();
  private readonly unavailableWalkshedKeys = new Map<string, number>();
  private readonly visibleStopIds = new Set<string>();
  private loadGeneration = 0;
  private viewportSyncTimeoutId: number | null = null;
  private activeLoadCount = 0;

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
    this.removePolygon(stop.id);
    this.removePlaceholderCircle(stop.id);
    this.removeUnavailableWalkshedKeysForStop(stop.id);
    this.scheduleViewportSyncIfEnabled();
  }

  removeStop(stopId: string): void {
    this.stopsById.delete(stopId);
    this.visibleStopIds.delete(stopId);
    this.queuedStopIds.delete(stopId);
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
    if (!enabled) this.clearOverlay();
    else this.scheduleViewportSync();
  }

  private radiusForStop(stop: Stop): number {
    return this.getRadiusMetersForType(stop.type);
  }

  private walkshedKey(stop: Stop, radiusMeters: number): string {
    return walkshedCacheKey(
      stop.id,
      radiusMeters,
      stop.lat,
      stop.lon,
      this.getAllowReasonableStreetCrossings(),
    );
  }

  private isWalkshedUnavailable(stop: Stop, radiusMeters: number): boolean {
    const key = this.walkshedKey(stop, radiusMeters);
    const retryAfter = this.unavailableWalkshedKeys.get(key);
    if (retryAfter === undefined) return false;
    if (retryAfter > Date.now()) return true;
    this.unavailableWalkshedKeys.delete(key);
    return false;
  }

  private removeUnavailableWalkshedKeysForStop(stopId: string): void {
    const prefix = walkshedCacheKeyPrefixForStop(stopId);
    for (const key of this.unavailableWalkshedKeys.keys()) {
      if (key.startsWith(prefix)) this.unavailableWalkshedKeys.delete(key);
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
    this.cancelScheduledViewportSync();
    this.polygonsByStopId.clear();
    this.placeholdersByStopId.clear();
    this.unavailableWalkshedKeys.clear();
    this.visibleStopIds.clear();
    this.updatePolygonSource();
    this.updatePlaceholderSource();
    this.emitLoadProgress();
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
        this.radiusForStop(stop),
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
      else if (this.isWalkshedUnavailable(stop, this.radiusForStop(stop))) unavailable += 1;
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
      !this.loadingStopIds.has(stop.id) &&
      !this.isWalkshedUnavailable(stop, this.radiusForStop(stop))
    );
  }

  private canEnqueueStop(stop: Stop): boolean {
    return this.isStopEligibleForLoad(stop) && !this.queuedStopIds.has(stop.id);
  }

  private isLoadResultCurrent(stop: Stop, generation: number, radiusMeters: number): boolean {
    return (
      generation === this.loadGeneration &&
      this.isEnabled() &&
      radiusMeters === this.radiusForStop(stop) &&
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
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const stopId of this.queuedStopIds) {
      const stop = this.stopsById.get(stopId);
      if (!stop) continue;
      const latDistance = stop.lat - center.lat;
      const lonDistance = (stop.lon - center.lng) * Math.cos((center.lat * Math.PI) / 180);
      const distance = latDistance * latDistance + lonDistance * lonDistance;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestStopId = stopId;
      }
    }
    if (nearestStopId) this.queuedStopIds.delete(nearestStopId);
    return nearestStopId;
  }

  private syncVisibleWalksheds(): void {
    if (!this.isEnabled()) return;
    const generation = this.loadGeneration;
    const loadableStops: Stop[] = [];
    let polygonsChanged = false;
    let placeholdersChanged = false;
    this.visibleStopIds.clear();
    for (const stop of this.stopsById.values()) {
      if (!this.isStopWithinBounds(stop)) continue;
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
    if (polygonsChanged) this.updatePolygonSource();
    if (placeholdersChanged) this.updatePlaceholderSource();
    void this.renderCachedOrEnqueueStops(loadableStops, generation);
    this.emitLoadProgress();
  }

  private async renderCachedOrEnqueueStops(stops: Stop[], generation: number): Promise<void> {
    await Promise.all(stops.map((stop) => this.renderCachedOrEnqueue(stop, generation)));
    if (generation === this.loadGeneration) this.processLoadQueue();
  }

  private async renderCachedOrEnqueue(stop: Stop, generation: number): Promise<void> {
    const radiusMeters = this.radiusForStop(stop);
    const polygon = await peekCachedWalkshedPolygon(
      stop,
      radiusMeters,
      this.getAllowReasonableStreetCrossings(),
    );
    if (!this.isLoadResultCurrent(stop, generation, radiusMeters) || !this.canEnqueueStop(stop))
      return;
    if (polygon) this.renderPolygon(stop, polygon, radiusMeters);
    else this.queuedStopIds.add(stop.id);
  }

  private async loadWalkshedForStop(stop: Stop, generation: number, radiusMeters: number) {
    const result = await buildWalkshedPolygon(
      stop,
      radiusMeters,
      this.getAllowReasonableStreetCrossings(),
    );
    if (!this.isLoadResultCurrent(stop, generation, radiusMeters)) return;
    if (result.status === 'superseded') return;
    if (result.status === 'unavailable') {
      this.unavailableWalkshedKeys.set(this.walkshedKey(stop, radiusMeters), result.retryAfter);
      this.priorityStopIds.delete(stop.id);
      this.removePlaceholderCircle(stop.id);
      this.emitLoadProgress();
      const delay = Math.max(0, result.retryAfter - Date.now());
      window.setTimeout(() => {
        if (this.isEnabled() && generation === this.loadGeneration) this.scheduleViewportSync();
      }, delay);
      return;
    }
    this.renderPolygon(stop, result.polygon, radiusMeters);
  }

  private renderPolygon(stop: Stop, polygon: LatLng[], radiusMeters: number): void {
    this.unavailableWalkshedKeys.delete(this.walkshedKey(stop, radiusMeters));
    this.priorityStopIds.delete(stop.id);
    this.removePlaceholderCircle(stop.id);
    const coordinates = polygon.map(([lat, lon]): [number, number] => [lon, lat]);
    if (coordinates.length > 0) coordinates.push(coordinates[0]);
    const feature: Feature<Polygon, PolygonFeature['properties']> = {
      type: 'Feature',
      properties: { stopId: stop.id, color: STOP_TYPE_CONFIG[stop.type].color },
      geometry: { type: 'Polygon', coordinates: [coordinates] },
    };
    this.polygonsByStopId.set(stop.id, feature);
    this.updatePolygonSource();
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
      const loadToken = Symbol(stopId);
      this.activeLoadCount += 1;
      this.loadingStopIds.set(stopId, loadToken);
      void this.loadWalkshedForStop(stop, generation, radiusMeters)
        .catch((error) => console.error(`Walkshed failed for ${stopId}:`, error))
        .finally(() => {
          this.activeLoadCount = Math.max(0, this.activeLoadCount - 1);
          if (this.loadingStopIds.get(stopId) === loadToken) this.loadingStopIds.delete(stopId);
          if (this.isEnabled()) {
            this.processLoadQueue();
            this.scheduleViewportSync();
          }
        });
    }
  }
}
