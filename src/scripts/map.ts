import L from 'leaflet';
import {
  addCustomStop,
  CUSTOM_STOPS_STORAGE_KEY,
  removeCustomStop,
  updateCustomStopPosition,
} from '../lib/custom-stops-client';
import {
  ADD_STOP_FORM_SELECTOR,
  ADD_STOP_NAME_SELECTOR,
  ADD_STOP_TYPE_SELECTOR,
  STOP_REMOVE_BUTTON_SELECTOR,
  STOP_WALKSHED_TOGGLE_BUTTON_SELECTOR,
  createAddStopPopupHtml,
  createStopPopupHtml,
  getStopWalkshedToggleLabel,
} from '../lib/map-popups';
import {
  COVERAGE_SHAPE_DISPLAY_LABELS,
  SETTINGS_STORAGE_KEYS,
  type CoverageShape,
  type StopRadiusByType,
  type StopTypeVisibilityByType,
  getConfiguredCoverageShape,
  getConfiguredStopRadii,
  getConfiguredStopTypeVisibility,
  setConfiguredStopTypeVisibility,
} from '../lib/settings';
import { formatStopRadiusSummary, STOP_TYPE_CONFIG } from '../lib/stop-type-config';
import { loadAllStops } from '../lib/stops-repository';
import {
  WALKSHED_DISABLED_STOPS_STORAGE_KEY,
  getWalkshedDisabledStopIds,
  setWalkshedDisabledForStop,
} from '../lib/walkshed-disabled-stops';
import {
  WALKSHED_CACHE_RESET_MARKER_KEY,
  getWalkshedCacheResetMarker,
  reloadCacheIfExternallyReset,
  removeCachedWalkshedPolygonsForStop,
} from '../lib/walkshed-cache';
import {
  clearWalkshedRuntimeCache,
  removeWalkshedRuntimeCacheForStop,
} from '../lib/walkshed/service';
import {
  STOP_TYPES,
  isStopType,
  stopTypeRecordChanged,
  type Stop,
  type StopType,
} from '../lib/types';
import { createCustomStopMarkerIcon } from './map/custom-stop-marker-icon';
import { WalkshedOverlayManager } from './map/walkshed-overlay-manager';

const MAP_CONTAINER_ID = 'map';
const MAP_INITIAL_CENTER: [number, number] = [49.0069, 8.4037];
const MAP_INITIAL_ZOOM = 13;
const STOP_PATH_PANE_NAME = 'stop-path-pane';
const WALKSHED_PANE_NAME = 'walkshed-pane';
const STOP_PATH_PANE_Z_INDEX = 460;
const WALKSHED_PANE_Z_INDEX = 450;
const STOP_CIRCLE_FILL_OPACITY = 0.06;
const STOP_CIRCLE_STROKE_OPACITY = 0.75;
const STOP_TYPE_TOGGLE_SELECTOR = '[data-stop-type-toggle]';
const SYNCED_STORAGE_KEYS = new Set([
  ...SETTINGS_STORAGE_KEYS,
  WALKSHED_CACHE_RESET_MARKER_KEY,
  WALKSHED_DISABLED_STOPS_STORAGE_KEY,
]);

interface StopLayer {
  layer: L.LayerGroup;
  radiusCircle?: L.Circle;
}

type StopMarker = L.CircleMarker | L.Marker;

function ensurePane(map: L.Map, paneName: string, zIndex: number): void {
  const pane = map.getPane(paneName) ?? map.createPane(paneName);
  pane.style.zIndex = String(zIndex);
}

class TransitMapController {
  private readonly map: L.Map;
  private readonly coverageInfoEl: HTMLElement | null;
  private readonly radiusInfoEl: HTMLElement | null;
  private readonly stopRootLayer: L.LayerGroup;
  private readonly walkshedOverlay: WalkshedOverlayManager;
  private readonly stopTypeToggleButtons = new Map<StopType, HTMLButtonElement>();

  private readonly stopLayersById = new Map<string, StopLayer>();
  private readonly stopsById = new Map<string, Stop>();

  private radiusMetersByType: StopRadiusByType = getConfiguredStopRadii();
  private visibleStopTypes: StopTypeVisibilityByType = getConfiguredStopTypeVisibility();
  private coverageShape: CoverageShape = getConfiguredCoverageShape();
  private walkshedDisabledStopIds = getWalkshedDisabledStopIds();
  private walkshedCacheResetMarker = getWalkshedCacheResetMarker();
  private stopLoadVersion = 0;
  private suppressNextMapClick = false;

  constructor(map: L.Map) {
    this.map = map;
    this.coverageInfoEl = document.querySelector('[data-coverage-info]');
    this.radiusInfoEl = document.querySelector('[data-radius-info]');
    this.stopRootLayer = L.layerGroup().addTo(map);
    this.walkshedOverlay = new WalkshedOverlayManager({
      map,
      getRadiusMetersForType: (stopType) => this.radiusMetersByType[stopType],
      isEnabled: () => this.coverageShape === 'walkshed',
      paneName: WALKSHED_PANE_NAME,
    });
  }

  init(): void {
    this.updateLegend();
    this.bindSettingsSync();
    this.bindStopTypeToggles();

    this.map.on('moveend zoomend', () => this.walkshedOverlay.onViewportChanged());
    this.map.on('click', (event: L.LeafletMouseEvent) => {
      if (this.suppressNextMapClick) {
        this.suppressNextMapClick = false;
        return;
      }

      this.showAddStopPopup(event.latlng);
    });

    void this.loadStops();
  }

  private allStops(): Stop[] {
    return Array.from(this.stopsById.values());
  }

  private visibleStops(): Stop[] {
    return this.allStops().filter((stop) => this.visibleStopTypes[stop.type]);
  }

  private walkshedVisibleStops(): Stop[] {
    return this.visibleStops().filter((stop) => !this.walkshedDisabledStopIds.has(stop.id));
  }

  private syncWalkshedForStop(stop: Stop): void {
    if (!this.visibleStopTypes[stop.type] || this.walkshedDisabledStopIds.has(stop.id)) {
      this.walkshedOverlay.removeStop(stop.id);
      return;
    }

    this.walkshedOverlay.addOrUpdateStop(stop);
  }

  private setStopWalkshedDisabled(stop: Stop, disabled: boolean): void {
    const wasDisabled = this.walkshedDisabledStopIds.has(stop.id);
    const nextDisabled = setWalkshedDisabledForStop(stop.id, disabled);
    if (wasDisabled === nextDisabled) return;

    if (nextDisabled) {
      this.walkshedDisabledStopIds.add(stop.id);
    } else {
      this.walkshedDisabledStopIds.delete(stop.id);
    }

    this.syncWalkshedForStop(stop);
  }

  private updateWalkshedToggleButton(button: HTMLButtonElement, stopId: string): void {
    const isDisabled = this.walkshedDisabledStopIds.has(stopId);
    const toggleLabel = getStopWalkshedToggleLabel(isDisabled);
    button.setAttribute('aria-pressed', isDisabled ? 'true' : 'false');
    button.setAttribute('aria-label', toggleLabel);
    button.textContent = toggleLabel;
  }

  private updateLegend(): void {
    if (this.radiusInfoEl) {
      const radiusSummary = formatStopRadiusSummary(this.radiusMetersByType);
      this.radiusInfoEl.textContent = `Radien: ${radiusSummary}`;
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
  }

  private removeStop(stopId: string): void {
    this.removeStopLayer(stopId);
    this.stopsById.delete(stopId);
    this.walkshedOverlay.removeStop(stopId);
  }

  private releaseMapClickSuppression(): void {
    window.setTimeout(() => {
      this.suppressNextMapClick = false;
    }, 0);
  }

  private createStopMarker(stop: Stop, center: L.LatLngTuple, color: string): StopMarker {
    if (stop.isCustom) {
      return L.marker(center, {
        icon: createCustomStopMarkerIcon(stop.type, color),
        draggable: true,
        keyboard: true,
        riseOnHover: true,
      });
    }

    return L.circleMarker(center, {
      radius: STOP_TYPE_CONFIG[stop.type].markerRadius,
      color,
      fillColor: color,
      fillOpacity: 0.8,
      weight: 1,
      pane: STOP_PATH_PANE_NAME,
    });
  }

  private invalidateStopWalkshedCache(stopId: string): void {
    removeCachedWalkshedPolygonsForStop(stopId);
    removeWalkshedRuntimeCacheForStop(stopId);
    this.walkshedCacheResetMarker = getWalkshedCacheResetMarker();
  }

  private bindCustomStopRemoval(marker: StopMarker, stop: Stop): void {
    if (!stop.isCustom) return;

    marker.on('popupopen', (event: L.PopupEvent) => {
      const removeBtn = event.popup
        .getElement()
        ?.querySelector<HTMLButtonElement>(STOP_REMOVE_BUTTON_SELECTOR);
      if (!removeBtn || removeBtn.dataset.bound === 'true') return;

      removeBtn.dataset.bound = 'true';
      removeBtn.addEventListener('click', (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();

        removeBtn.disabled = true;
        removeBtn.textContent = 'Entferne...';

        if (removeCustomStop(stop.id)) {
          this.invalidateStopWalkshedCache(stop.id);
          this.removeStop(stop.id);
          this.map.closePopup(event.popup);
          return;
        }

        removeBtn.disabled = false;
        removeBtn.textContent = 'Haltestelle entfernen';
      });
    });
  }

  private bindWalkshedToggle(marker: StopMarker, stop: Stop): void {
    if (stop.isCustom) return;

    marker.on('popupopen', (event: L.PopupEvent) => {
      const toggleBtn = event.popup
        .getElement()
        ?.querySelector<HTMLButtonElement>(STOP_WALKSHED_TOGGLE_BUTTON_SELECTOR);
      if (!toggleBtn) return;

      this.updateWalkshedToggleButton(toggleBtn, stop.id);
      if (toggleBtn.dataset.bound === 'true') return;
      toggleBtn.dataset.bound = 'true';

      toggleBtn.addEventListener('click', (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();

        this.setStopWalkshedDisabled(stop, !this.walkshedDisabledStopIds.has(stop.id));
        this.updateWalkshedToggleButton(toggleBtn, stop.id);
      });
    });
  }

  private bindCustomStopDragging(marker: StopMarker, stop: Stop, radiusCircle?: L.Circle): void {
    if (!stop.isCustom || !(marker instanceof L.Marker)) return;

    let dragStartPosition = marker.getLatLng();

    marker.on('dragstart', () => {
      dragStartPosition = marker.getLatLng();
      this.suppressNextMapClick = true;

      if (this.coverageShape === 'walkshed') {
        this.walkshedOverlay.removeStop(stop.id);
      }
    });

    marker.on('drag', () => {
      radiusCircle?.setLatLng(marker.getLatLng());
    });

    marker.on('dragend', () => {
      const position = marker.getLatLng();
      const hasMoved = !position.equals(dragStartPosition);

      if (!hasMoved) {
        this.syncWalkshedForStop(stop);
        this.releaseMapClickSuppression();
        return;
      }

      const updatedStop = updateCustomStopPosition(stop.id, position.lat, position.lng);

      if (!updatedStop) {
        marker.setLatLng(dragStartPosition);
        radiusCircle?.setLatLng(dragStartPosition);
        this.syncWalkshedForStop(stop);
      } else {
        this.invalidateStopWalkshedCache(stop.id);

        this.addOrUpdateStop(updatedStop);
        if (
          this.coverageShape === 'walkshed' &&
          !this.walkshedDisabledStopIds.has(updatedStop.id)
        ) {
          this.walkshedOverlay.prioritizeStop(updatedStop);
        }
      }

      this.releaseMapClickSuppression();
    });
  }

  private createStopLayer(stop: Stop): StopLayer {
    const center: L.LatLngTuple = [stop.lat, stop.lon];
    const color = STOP_TYPE_CONFIG[stop.type].color;
    const layers: L.Layer[] = [];

    let radiusCircle: L.Circle | undefined;
    if (this.coverageShape === 'circle') {
      radiusCircle = L.circle(center, {
        radius: this.radiusMetersByType[stop.type],
        color,
        fillColor: color,
        fillOpacity: STOP_CIRCLE_FILL_OPACITY,
        opacity: STOP_CIRCLE_STROKE_OPACITY,
        weight: 2,
        interactive: false,
        pane: STOP_PATH_PANE_NAME,
      });
      layers.push(radiusCircle);
    }

    const marker = this.createStopMarker(stop, center, color).bindPopup(
      createStopPopupHtml(stop, {
        walkshedDisabled: this.walkshedDisabledStopIds.has(stop.id),
      }),
    );

    marker.on('click', () => {
      if (this.coverageShape === 'walkshed' && !this.walkshedDisabledStopIds.has(stop.id)) {
        this.walkshedOverlay.prioritizeStop(stop);
      }
    });

    layers.push(marker);
    this.bindCustomStopRemoval(marker, stop);
    this.bindWalkshedToggle(marker, stop);
    this.bindCustomStopDragging(marker, stop, radiusCircle);

    return { layer: L.layerGroup(layers), radiusCircle };
  }

  private addStopLayer(stop: Stop): void {
    if (!this.visibleStopTypes[stop.type]) return;

    const stopLayer = this.createStopLayer(stop);
    this.stopLayersById.set(stop.id, stopLayer);
    this.stopRootLayer.addLayer(stopLayer.layer);
  }

  private renderAllStopLayers(): void {
    this.stopRootLayer.clearLayers();
    this.stopLayersById.clear();

    for (const stop of this.stopsById.values()) {
      this.addStopLayer(stop);
    }
  }

  private setStops(stops: Stop[]): void {
    this.stopsById.clear();
    for (const stop of stops) {
      this.stopsById.set(stop.id, stop);
    }

    this.renderAllStopLayers();
    this.walkshedOverlay.setStops(this.walkshedVisibleStops());
  }

  private addOrUpdateStop(stop: Stop): void {
    this.stopsById.set(stop.id, stop);
    this.removeStopLayer(stop.id);

    if (this.visibleStopTypes[stop.type]) {
      this.addStopLayer(stop);
      this.syncWalkshedForStop(stop);
      return;
    }

    this.walkshedOverlay.removeStop(stop.id);
  }

  private async loadStops(): Promise<void> {
    const version = ++this.stopLoadVersion;

    try {
      const stops = await loadAllStops();
      if (version !== this.stopLoadVersion) return;
      this.setStops(stops);
    } catch (error) {
      if (version !== this.stopLoadVersion) return;
      console.error('Failed to load stops:', error);
    }
  }

  private setRadii(radiusByType: StopRadiusByType): void {
    const hasChanged = stopTypeRecordChanged(radiusByType, this.radiusMetersByType);
    if (!hasChanged) return;

    this.radiusMetersByType = { ...radiusByType };
    for (const [stopId, stopLayer] of this.stopLayersById.entries()) {
      const stop = this.stopsById.get(stopId);
      if (!stop) continue;

      stopLayer.radiusCircle?.setRadius(this.radiusMetersByType[stop.type]);
    }

    this.updateLegend();
    this.walkshedOverlay.onSettingsChanged();
  }

  private setCoverageShape(shape: CoverageShape): void {
    if (shape === this.coverageShape) return;

    this.coverageShape = shape;
    this.updateLegend();
    this.walkshedOverlay.onCoverageModeChanged(shape === 'walkshed');
    this.renderAllStopLayers();
  }

  private setWalkshedDisabledStopIds(nextStopIds: Set<string>): void {
    const hasChanged =
      nextStopIds.size !== this.walkshedDisabledStopIds.size ||
      [...nextStopIds].some((stopId) => !this.walkshedDisabledStopIds.has(stopId));
    if (!hasChanged) return;

    this.walkshedDisabledStopIds = new Set(nextStopIds);
    this.walkshedOverlay.setStops(this.walkshedVisibleStops());
  }

  private syncSettingsFromStorage(): void {
    const marker = getWalkshedCacheResetMarker();
    if (marker !== this.walkshedCacheResetMarker) {
      this.walkshedCacheResetMarker = marker;
      reloadCacheIfExternallyReset();
      clearWalkshedRuntimeCache();
      this.walkshedOverlay.onSettingsChanged();
    }

    this.setVisibleStopTypes(getConfiguredStopTypeVisibility());
    this.setWalkshedDisabledStopIds(getWalkshedDisabledStopIds());
    this.setCoverageShape(getConfiguredCoverageShape());
    this.setRadii(getConfiguredStopRadii());
  }

  private bindSettingsSync(): void {
    const sync = () => this.syncSettingsFromStorage();

    window.addEventListener('focus', sync);
    window.addEventListener('pageshow', sync);
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key === CUSTOM_STOPS_STORAGE_KEY) {
        void this.loadStops();
        return;
      }

      if (event.key && SYNCED_STORAGE_KEYS.has(event.key)) sync();
    });
  }

  private syncStopTypeToggleButtons(): void {
    for (const stopType of STOP_TYPES) {
      const button = this.stopTypeToggleButtons.get(stopType);
      if (!button) continue;

      button.setAttribute('aria-pressed', this.visibleStopTypes[stopType] ? 'true' : 'false');
    }
  }

  private setVisibleStopTypes(nextVisibleStopTypes: StopTypeVisibilityByType): void {
    const hasChanged = stopTypeRecordChanged(nextVisibleStopTypes, this.visibleStopTypes);

    this.visibleStopTypes = { ...nextVisibleStopTypes };
    this.syncStopTypeToggleButtons();

    if (!hasChanged) return;

    this.renderAllStopLayers();
    this.walkshedOverlay.setStops(this.walkshedVisibleStops());
  }

  private bindStopTypeToggles(): void {
    const buttons = document.querySelectorAll<HTMLButtonElement>(STOP_TYPE_TOGGLE_SELECTOR);

    for (const button of buttons) {
      const stopType = button.dataset.stopTypeToggle;
      if (!isStopType(stopType)) continue;

      this.stopTypeToggleButtons.set(stopType, button);
      button.addEventListener('click', () => {
        const nextVisibleStopTypes = {
          ...this.visibleStopTypes,
          [stopType]: !this.visibleStopTypes[stopType],
        };

        this.setVisibleStopTypes(setConfiguredStopTypeVisibility(nextVisibleStopTypes));
      });
    }

    this.syncStopTypeToggleButtons();
  }

  private showAddStopPopup(latlng: L.LatLng): void {
    const popup = L.popup().setLatLng(latlng).setContent(createAddStopPopupHtml());

    popup.once('add', () => {
      const el = popup.getElement();
      const form = el?.querySelector<HTMLFormElement>(ADD_STOP_FORM_SELECTOR);
      const input = el?.querySelector<HTMLInputElement>(ADD_STOP_NAME_SELECTOR);
      const typeInput = el?.querySelector<HTMLSelectElement>(ADD_STOP_TYPE_SELECTOR);
      if (!form || !input || !typeInput) return;

      input.focus();
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const name = input.value.trim();
        const stopType = typeInput.value;

        if (!name || !isStopType(stopType)) return;

        const stop = addCustomStop({ name, type: stopType, lat: latlng.lat, lon: latlng.lng });
        this.addOrUpdateStop(stop);
        this.map.closePopup(popup);
      });
    });

    popup.openOn(this.map);
  }
}

export function initMap(): void {
  const container = document.getElementById(MAP_CONTAINER_ID);
  if (!container) return;

  const map = L.map(MAP_CONTAINER_ID, { preferCanvas: true }).setView(
    MAP_INITIAL_CENTER,
    MAP_INITIAL_ZOOM,
  );
  ensurePane(map, WALKSHED_PANE_NAME, WALKSHED_PANE_Z_INDEX);
  ensurePane(map, STOP_PATH_PANE_NAME, STOP_PATH_PANE_Z_INDEX);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  new TransitMapController(map).init();
}
