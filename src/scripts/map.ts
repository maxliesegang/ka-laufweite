import L from 'leaflet';
import {
  addCustomStop,
  removeCustomStop,
  updateCustomStopPosition,
} from '../lib/custom-stops-client';
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
  COVERAGE_SHAPE_DISPLAY_LABELS,
  COVERAGE_SHAPE_STORAGE_KEY,
  STOP_RADIUS_STORAGE_KEY,
  type CoverageShape,
  getConfiguredCoverageShape,
  getConfiguredStopRadius,
} from '../lib/settings';
import { loadAllStops } from '../lib/stops-repository';
import {
  WALKSHED_CACHE_RESET_MARKER_KEY,
  clearWalkshedCache,
  getWalkshedCacheResetMarker,
} from '../lib/walkshed-cache';
import { clearWalkshedRuntimeCache } from '../lib/walkshed/service';
import type { Stop } from '../lib/types';
import { WalkshedOverlayManager } from './map/walkshed-overlay-manager';

const MAP_CONTAINER_ID = 'map';
const STOP_CIRCLE_FILL_OPACITY = 0.06;
const STOP_CIRCLE_STROKE_OPACITY = 0.75;
const CUSTOM_STOP_TOUCH_TARGET_PX = 34;
const CUSTOM_STOP_MARKER_BORDER_PX = 2;
const CUSTOM_STOP_MARKER_CENTER_DOT_PX = STOP_MARKER_RADIUS.custom * 2;
const SYNCED_STORAGE_KEYS = new Set([
  STOP_RADIUS_STORAGE_KEY,
  COVERAGE_SHAPE_STORAGE_KEY,
  WALKSHED_CACHE_RESET_MARKER_KEY,
]);

interface StopLayer {
  layer: L.LayerGroup;
  radiusCircle?: L.Circle;
}

type StopMarker = L.CircleMarker | L.Marker;

class TransitMapController {
  private readonly map: L.Map;
  private readonly coverageInfoEl: HTMLElement | null;
  private readonly radiusInfoEl: HTMLElement | null;
  private readonly stopRootLayer: L.LayerGroup;
  private readonly walkshedOverlay: WalkshedOverlayManager;

  private readonly stopLayersById = new Map<string, StopLayer>();
  private readonly stopsById = new Map<string, Stop>();

  private radiusMeters = getConfiguredStopRadius();
  private coverageShape: CoverageShape = getConfiguredCoverageShape();
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
      getRadiusMeters: () => this.radiusMeters,
      isEnabled: () => this.coverageShape === 'walkshed',
    });
  }

  init(): void {
    this.updateLegend();
    this.bindSettingsSync();

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
  }

  private removeStop(stopId: string): void {
    this.removeStopLayer(stopId);
    this.stopsById.delete(stopId);
    this.walkshedOverlay.removeStop(stopId);
  }

  private createCustomStopMarkerIcon(color: string): L.DivIcon {
    const targetSize = CUSTOM_STOP_TOUCH_TARGET_PX;
    const dotSize = CUSTOM_STOP_MARKER_CENTER_DOT_PX;

    return L.divIcon({
      className: 'custom-stop-drag-marker',
      iconSize: [targetSize, targetSize],
      iconAnchor: [targetSize / 2, targetSize / 2],
      popupAnchor: [0, -(targetSize / 2)],
      html: `
        <span
          aria-hidden="true"
          style="
            width:${targetSize}px;
            height:${targetSize}px;
            display:flex;
            align-items:center;
            justify-content:center;
            touch-action:none;
          "
        >
          <span
            style="
              width:${dotSize}px;
              height:${dotSize}px;
              border-radius:999px;
              background:${color};
              border:${CUSTOM_STOP_MARKER_BORDER_PX}px solid #ffffff;
              box-shadow:0 0 0 1px ${color};
              opacity:0.95;
            "
          ></span>
        </span>
      `,
    });
  }

  private createStopMarker(stop: Stop, center: L.LatLngTuple, color: string): StopMarker {
    if (stop.type === 'custom') {
      return L.marker(center, {
        icon: this.createCustomStopMarkerIcon(color),
        draggable: true,
        keyboard: true,
        riseOnHover: true,
      });
    }

    return L.circleMarker(center, {
      radius: STOP_MARKER_RADIUS[stop.type],
      color,
      fillColor: color,
      fillOpacity: 0.8,
      weight: 1,
    });
  }

  private bindCustomStopRemoval(marker: StopMarker, stop: Stop): void {
    if (stop.type !== 'custom') return;

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
          this.removeStop(stop.id);
          this.map.closePopup(event.popup);
          return;
        }

        removeBtn.disabled = false;
        removeBtn.textContent = 'Haltestelle entfernen';
      });
    });
  }

  private bindCustomStopDragging(marker: StopMarker, stop: Stop, radiusCircle?: L.Circle): void {
    if (stop.type !== 'custom' || !(marker instanceof L.Marker)) return;

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
        this.walkshedOverlay.addOrUpdateStop(stop);
        window.setTimeout(() => {
          this.suppressNextMapClick = false;
        }, 0);
        return;
      }

      const updatedStop = updateCustomStopPosition(stop.id, position.lat, position.lng);

      if (!updatedStop) {
        marker.setLatLng(dragStartPosition);
        radiusCircle?.setLatLng(dragStartPosition);
        this.walkshedOverlay.addOrUpdateStop(stop);
      } else {
        clearWalkshedCache();
        clearWalkshedRuntimeCache();
        this.walkshedCacheResetMarker = getWalkshedCacheResetMarker();
        this.walkshedOverlay.onSettingsChanged();

        this.addOrUpdateStop(updatedStop);
        if (this.coverageShape === 'walkshed') {
          this.walkshedOverlay.prioritizeStop(updatedStop);
        }
      }

      window.setTimeout(() => {
        this.suppressNextMapClick = false;
      }, 0);
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

    const marker = this.createStopMarker(stop, center, color).bindPopup(createStopPopupHtml(stop));

    marker.on('click', () => {
      if (this.coverageShape === 'walkshed') {
        this.walkshedOverlay.prioritizeStop(stop);
      }
    });

    layers.push(marker);
    this.bindCustomStopRemoval(marker, stop);
    this.bindCustomStopDragging(marker, stop, radiusCircle);

    return { layer: L.layerGroup(layers), radiusCircle };
  }

  private addStopLayer(stop: Stop): void {
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
    this.walkshedOverlay.setStops(this.allStops());
  }

  private addOrUpdateStop(stop: Stop): void {
    this.stopsById.set(stop.id, stop);
    this.removeStopLayer(stop.id);
    this.addStopLayer(stop);
    this.walkshedOverlay.addOrUpdateStop(stop);
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
    this.renderAllStopLayers();
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
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key && SYNCED_STORAGE_KEYS.has(event.key)) sync();
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
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const name = input.value.trim();
        if (!name) return;

        const stop = addCustomStop({ name, lat: latlng.lat, lon: latlng.lng });
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

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  new TransitMapController(map).init();
}
