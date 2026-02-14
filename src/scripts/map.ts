import L from 'leaflet';
import { addCustomStop, removeCustomStop } from '../lib/custom-stops-client';
import {
  MAP_INITIAL_CENTER,
  MAP_INITIAL_ZOOM,
  STOP_COLORS,
  STOP_MARKER_RADIUS,
} from '../lib/map-config';
import {
  ADD_STOP_FORM_SELECTOR,
  ADD_STOP_NAME_SELECTOR,
  STOP_REMOVE_BUTTON_SELECTOR,
  createAddStopPopupHtml,
  createStopPopupHtml,
} from '../lib/map-popups';
import {
  COVERAGE_SHAPE_STORAGE_KEY,
  STOP_RADIUS_STORAGE_KEY,
  type CoverageShape,
  COVERAGE_SHAPE_DISPLAY_LABELS,
  getConfiguredCoverageShape,
  getConfiguredStopRadius,
} from '../lib/settings';
import { loadAllStops } from '../lib/stops-repository';
import { clearWalkshedRuntimeCache } from '../lib/walkshed/service';
import {
  WALKSHED_CACHE_RESET_MARKER_KEY,
  getWalkshedCacheResetMarker,
} from '../lib/walkshed-cache';
import type { Stop } from '../lib/types';
import { WalkshedOverlayManager } from './map/walkshed-overlay-manager';

const STOP_CIRCLE_FILL_OPACITY = 0.06;
const STOP_CIRCLE_STROKE_OPACITY = 0.75;

const SYNCED_STORAGE_KEYS = new Set([
  STOP_RADIUS_STORAGE_KEY,
  COVERAGE_SHAPE_STORAGE_KEY,
  WALKSHED_CACHE_RESET_MARKER_KEY,
]);

interface StopLayer {
  layer: L.LayerGroup;
  radiusCircle?: L.Circle;
}

class TransitMapController {
  private readonly map: L.Map;
  private readonly coverageInfoEl: HTMLElement | null;
  private readonly radiusInfoEl: HTMLElement | null;
  private readonly stopRootLayer: L.LayerGroup;
  private readonly walkshedOverlay: WalkshedOverlayManager;
  private readonly stopLayersById = new Map<string, StopLayer>();

  private radiusMeters = getConfiguredStopRadius();
  private coverageShape: CoverageShape = getConfiguredCoverageShape();
  private walkshedCacheResetMarker = getWalkshedCacheResetMarker();
  private stopLoadVersion = 0;

  constructor(map: L.Map) {
    this.map = map;
    this.coverageInfoEl = document.querySelector('[data-coverage-info]');
    this.radiusInfoEl = document.querySelector('[data-radius-info]');
    this.stopRootLayer = L.layerGroup().addTo(map);
    this.walkshedOverlay = new WalkshedOverlayManager({
      map,
      getRadiusMeters: () => this.radiusMeters,
      isEnabled: () => this.coverageShape === 'walkshed',
    });
  }

  init(): void {
    this.updateLegend();
    this.bindSettingsSync();
    this.map.on('moveend zoomend', () => this.walkshedOverlay.onViewportChanged());
    this.map.on('click', (e: L.LeafletMouseEvent) => this.showAddStopPopup(e.latlng));
    void this.loadStops();
  }

  private updateLegend(): void {
    if (this.radiusInfoEl) {
      this.radiusInfoEl.textContent = `Aktueller Radius: ${this.radiusMeters} m`;
    }
    if (this.coverageInfoEl) {
      this.coverageInfoEl.textContent = `Darstellung: ${COVERAGE_SHAPE_DISPLAY_LABELS[this.coverageShape]}`;
    }
  }

  private removeStopLayer(stopId: string): void {
    const stopLayer = this.stopLayersById.get(stopId);
    if (!stopLayer) return;

    this.stopRootLayer.removeLayer(stopLayer.layer);
    this.stopLayersById.delete(stopId);
    this.walkshedOverlay.removeStop(stopId);
  }

  private bindCustomStopRemoval(marker: L.CircleMarker, stop: Stop): void {
    if (stop.type !== 'custom') return;

    marker.on('popupopen', (event: L.PopupEvent) => {
      const removeBtn = event.popup
        .getElement()
        ?.querySelector<HTMLButtonElement>(STOP_REMOVE_BUTTON_SELECTOR);
      if (!removeBtn || removeBtn.dataset.bound === 'true') return;

      removeBtn.dataset.bound = 'true';
      removeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        removeBtn.disabled = true;
        removeBtn.textContent = 'Entferne...';

        if (removeCustomStop(stop.id)) {
          this.removeStopLayer(stop.id);
          this.map.closePopup(event.popup);
        } else {
          removeBtn.disabled = false;
          removeBtn.textContent = 'Haltestelle entfernen';
        }
      });
    });
  }

  private createStopLayer(stop: Stop): StopLayer {
    const center: L.LatLngTuple = [stop.lat, stop.lon];
    const color = STOP_COLORS[stop.type];
    const layers: L.Layer[] = [];

    let radiusCircle: L.Circle | undefined;
    if (this.coverageShape === 'circle') {
      radiusCircle = L.circle(center, {
        radius: this.radiusMeters,
        color,
        fillColor: color,
        fillOpacity: STOP_CIRCLE_FILL_OPACITY,
        opacity: STOP_CIRCLE_STROKE_OPACITY,
        weight: 2,
        interactive: false,
      });
      layers.push(radiusCircle);
    }

    const marker = L.circleMarker(center, {
      radius: STOP_MARKER_RADIUS[stop.type],
      color,
      fillColor: color,
      fillOpacity: 0.8,
      weight: 1,
    }).bindPopup(createStopPopupHtml(stop));

    marker.on('click', () => {
      if (this.coverageShape === 'walkshed') {
        this.walkshedOverlay.prioritizeStop(stop);
      }
    });

    layers.push(marker);
    this.bindCustomStopRemoval(marker, stop);

    return { layer: L.layerGroup(layers), radiusCircle };
  }

  private addStopLayer(stop: Stop): void {
    const stopLayer = this.createStopLayer(stop);
    this.stopLayersById.set(stop.id, stopLayer);
    this.stopRootLayer.addLayer(stopLayer.layer);
  }

  private async loadStops(): Promise<void> {
    const version = ++this.stopLoadVersion;

    try {
      const stops = await loadAllStops();
      if (version !== this.stopLoadVersion) return;

      this.stopRootLayer.clearLayers();
      this.stopLayersById.clear();
      for (const stop of stops) this.addStopLayer(stop);
      this.walkshedOverlay.setStops(stops);
    } catch (error) {
      if (version !== this.stopLoadVersion) return;
      console.error('Failed to load stops:', error);
    }
  }

  private setRadius(radiusMeters: number): void {
    if (radiusMeters === this.radiusMeters) return;

    this.radiusMeters = radiusMeters;
    for (const { radiusCircle } of this.stopLayersById.values()) {
      radiusCircle?.setRadius(radiusMeters);
    }
    this.updateLegend();
    this.walkshedOverlay.onSettingsChanged();
  }

  private setCoverageShape(shape: CoverageShape): void {
    if (shape === this.coverageShape) return;

    this.coverageShape = shape;
    this.updateLegend();
    this.walkshedOverlay.onCoverageModeChanged(shape === 'walkshed');
    void this.loadStops();
  }

  private syncSettingsFromStorage(): void {
    const marker = getWalkshedCacheResetMarker();
    if (marker !== this.walkshedCacheResetMarker) {
      this.walkshedCacheResetMarker = marker;
      clearWalkshedRuntimeCache();
      this.walkshedOverlay.onSettingsChanged();
    }

    this.setCoverageShape(getConfiguredCoverageShape());
    this.setRadius(getConfiguredStopRadius());
  }

  private bindSettingsSync(): void {
    const sync = () => this.syncSettingsFromStorage();

    window.addEventListener('focus', sync);
    window.addEventListener('pageshow', sync);
    window.addEventListener('storage', (e: StorageEvent) => {
      if (e.key && SYNCED_STORAGE_KEYS.has(e.key)) sync();
    });
  }

  private showAddStopPopup(latlng: L.LatLng): void {
    const popup = L.popup().setLatLng(latlng).setContent(createAddStopPopupHtml());

    popup.once('add', () => {
      const el = popup.getElement();
      const form = el?.querySelector<HTMLFormElement>(ADD_STOP_FORM_SELECTOR);
      const input = el?.querySelector<HTMLInputElement>(ADD_STOP_NAME_SELECTOR);
      if (!form || !input) return;

      input.focus();
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;

        const stop = addCustomStop({ name, lat: latlng.lat, lon: latlng.lng });
        this.addStopLayer(stop);
        this.walkshedOverlay.addOrUpdateStop(stop);
        this.map.closePopup(popup);
      });
    });

    popup.openOn(this.map);
  }
}

export function initMap(): void {
  const container = document.getElementById('map');
  if (!container) return;

  const map = L.map('map', { preferCanvas: true }).setView(MAP_INITIAL_CENTER, MAP_INITIAL_ZOOM);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  new TransitMapController(map).init();
}
