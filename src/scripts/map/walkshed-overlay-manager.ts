import L from 'leaflet';
import { STOP_COLORS } from '../../lib/map-config';
import type { Stop } from '../../lib/types';
import { buildWalkshedPolygon } from '../../lib/walkshed/service';

const FILL_OPACITY = 0.16;
const STROKE_OPACITY = 0.9;
const LOAD_CONCURRENCY = 4;
const SYNC_DEBOUNCE_MS = 120;
const BOUNDS_PADDING = 0.08;

interface OverlayManagerOptions {
  map: L.Map;
  getRadiusMeters: () => number;
  isEnabled: () => boolean;
}

export class WalkshedOverlayManager {
  private readonly map: L.Map;
  private readonly getRadiusMeters: () => number;
  private readonly isEnabled: () => boolean;
  private readonly rootLayer: L.LayerGroup;

  private readonly stopsById = new Map<string, Stop>();
  private readonly layersByStopId = new Map<string, L.Polygon>();
  private readonly pendingStopIds = new Set<string>();
  private readonly inFlightStopIds = new Set<string>();
  private readonly unavailableKeys = new Set<string>();

  private pipelineVersion = 0;
  private syncTimeoutId: number | null = null;
  private activeWorkers = 0;

  constructor(options: OverlayManagerOptions) {
    this.map = options.map;
    this.getRadiusMeters = options.getRadiusMeters;
    this.isEnabled = options.isEnabled;
    this.rootLayer = L.layerGroup().addTo(this.map);
  }

  setStops(stops: Stop[]): void {
    this.stopsById.clear();
    for (const stop of stops) {
      this.stopsById.set(stop.id, stop);
    }

    this.clearVisualization();
    this.scheduleSyncIfEnabled();
  }

  addOrUpdateStop(stop: Stop): void {
    this.stopsById.set(stop.id, stop);
    this.scheduleSyncIfEnabled();
  }

  removeStop(stopId: string): void {
    this.stopsById.delete(stopId);
    this.pendingStopIds.delete(stopId);
    this.inFlightStopIds.delete(stopId);
    this.removeLayer(stopId);
    this.removeUnavailableKeysForStop(stopId);
  }

  prioritizeStop(stop: Stop): void {
    if (!this.isEnabled()) return;

    this.stopsById.set(stop.id, stop);
    this.enqueueStop(stop);
    this.drainQueue();
  }

  onViewportChanged(): void {
    this.scheduleSyncIfEnabled();
  }

  onSettingsChanged(): void {
    this.clearVisualization();
    this.scheduleSyncIfEnabled();
  }

  onCoverageModeChanged(enabled: boolean): void {
    if (!enabled) {
      this.clearVisualization();
      return;
    }

    this.scheduleVisibleSync();
  }

  private unavailableKey(stopId: string, radiusMeters: number): string {
    return `${stopId}:${radiusMeters}`;
  }

  private isUnavailable(stopId: string, radiusMeters: number): boolean {
    return this.unavailableKeys.has(this.unavailableKey(stopId, radiusMeters));
  }

  private removeUnavailableKeysForStop(stopId: string): void {
    for (const key of [...this.unavailableKeys]) {
      if (key.startsWith(`${stopId}:`)) {
        this.unavailableKeys.delete(key);
      }
    }
  }

  private currentBounds(): L.LatLngBounds {
    return this.map.getBounds().pad(BOUNDS_PADDING);
  }

  private isStopInBounds(stop: Stop, bounds = this.currentBounds()): boolean {
    return bounds.contains([stop.lat, stop.lon]);
  }

  private scheduleSyncIfEnabled(): void {
    if (this.isEnabled()) {
      this.scheduleVisibleSync();
    }
  }

  private clearSyncTimeout(): void {
    if (this.syncTimeoutId === null) return;
    clearTimeout(this.syncTimeoutId);
    this.syncTimeoutId = null;
  }

  private clearVisualization(): void {
    this.pipelineVersion += 1;
    this.pendingStopIds.clear();
    this.clearSyncTimeout();
    this.rootLayer.clearLayers();
    this.layersByStopId.clear();
    this.unavailableKeys.clear();
  }

  private removeLayer(stopId: string): void {
    const layer = this.layersByStopId.get(stopId);
    if (!layer) return;

    this.rootLayer.removeLayer(layer);
    this.layersByStopId.delete(stopId);
  }

  private enqueueStop(stop: Stop): void {
    const radius = this.getRadiusMeters();
    if (this.layersByStopId.has(stop.id)) return;
    if (this.inFlightStopIds.has(stop.id)) return;
    if (this.isUnavailable(stop.id, radius)) return;

    this.pendingStopIds.add(stop.id);
  }

  private dequeueStopId(): string | null {
    const next = this.pendingStopIds.values().next();
    if (next.done) return null;

    this.pendingStopIds.delete(next.value);
    return next.value;
  }

  private scheduleVisibleSync(): void {
    this.clearSyncTimeout();
    this.syncTimeoutId = window.setTimeout(() => {
      this.syncTimeoutId = null;
      this.syncVisibleCoverage();
    }, SYNC_DEBOUNCE_MS);
  }

  private syncVisibleCoverage(): void {
    if (!this.isEnabled()) return;

    const bounds = this.currentBounds();
    const visibleStopIds = new Set<string>();

    for (const stop of this.stopsById.values()) {
      if (!this.isStopInBounds(stop, bounds)) continue;
      visibleStopIds.add(stop.id);
      this.enqueueStop(stop);
    }

    for (const stopId of [...this.layersByStopId.keys()]) {
      if (!visibleStopIds.has(stopId)) {
        this.removeLayer(stopId);
      }
    }

    for (const stopId of [...this.pendingStopIds]) {
      if (!visibleStopIds.has(stopId)) {
        this.pendingStopIds.delete(stopId);
      }
    }

    this.drainQueue();
  }

  private async loadWalkshedForStop(
    stop: Stop,
    version: number,
    radiusMeters: number,
  ): Promise<void> {
    const unavailableKey = this.unavailableKey(stop.id, radiusMeters);
    const polygon = await buildWalkshedPolygon(stop, radiusMeters);

    if (version !== this.pipelineVersion) return;
    if (!this.isEnabled()) return;
    if (radiusMeters !== this.getRadiusMeters()) return;
    if (!this.stopsById.has(stop.id)) return;
    if (!this.isStopInBounds(stop)) return;

    if (!polygon) {
      this.unavailableKeys.add(unavailableKey);
      return;
    }

    this.unavailableKeys.delete(unavailableKey);
    this.removeLayer(stop.id);

    const color = STOP_COLORS[stop.type];
    const layer = L.polygon(polygon, {
      color,
      fillColor: color,
      fillOpacity: FILL_OPACITY,
      opacity: STROKE_OPACITY,
      weight: 2,
      interactive: false,
    });

    this.layersByStopId.set(stop.id, layer);
    this.rootLayer.addLayer(layer);
  }

  private drainQueue(): void {
    if (!this.isEnabled()) return;

    while (this.activeWorkers < LOAD_CONCURRENCY) {
      const stopId = this.dequeueStopId();
      if (!stopId) return;

      const stop = this.stopsById.get(stopId);
      const radius = this.getRadiusMeters();

      if (!stop) continue;
      if (this.layersByStopId.has(stopId)) continue;
      if (this.inFlightStopIds.has(stopId)) continue;
      if (this.isUnavailable(stopId, radius)) continue;

      const version = this.pipelineVersion;
      this.activeWorkers += 1;
      this.inFlightStopIds.add(stopId);

      void this.loadWalkshedForStop(stop, version, radius)
        .catch((error) => console.error(`Walkshed failed for ${stopId}:`, error))
        .finally(() => {
          this.activeWorkers = Math.max(0, this.activeWorkers - 1);
          this.inFlightStopIds.delete(stopId);
          if (this.isEnabled()) this.drainQueue();
        });
    }
  }
}
