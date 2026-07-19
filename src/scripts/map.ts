import maplibregl, {
  type GeoJSONSource,
  type LngLat,
  type Map as MapLibreMap,
  type Marker,
  type Popup,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection, Point, Polygon } from 'geojson';
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
  matchesShippedWalkshedDefaults,
  getConfiguredCoverageShape,
  getAllowReasonableStreetCrossings,
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
  invalidateWalkshedRuntimeCacheForStop,
} from '../lib/walkshed/service';
import { preloadShippedWalksheds } from '../lib/walkshed/shipped-walksheds';
import {
  STOP_TYPES,
  isStopType,
  stopTypeRecordChanged,
  type Stop,
  type StopType,
} from '../lib/types';
import { createCustomStopMarkerElement } from './map/custom-stop-marker-icon';
import { circlePolygon, emptyPolygonCollection, type PolygonFeature } from './map/map-geometry';
import { WalkshedOverlayManager, type WalkshedLoadProgress } from './map/walkshed-overlay-manager';

const MAP_CONTAINER_ID = 'map';
const MAP_INITIAL_CENTER: [number, number] = [8.4037, 49.0069];
const MAP_INITIAL_ZOOM = 13;
const DEFAULT_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const STOP_SOURCE_ID = 'transit-stops';
const STOP_LAYER_ID = 'transit-stops-symbols';
const RADIUS_SOURCE_ID = 'stop-radius-polygons';
const RADIUS_FILL_LAYER_ID = 'stop-radius-fill';
const RADIUS_LINE_LAYER_ID = 'stop-radius-line';
const STOP_CIRCLE_FILL_OPACITY = 0.06;
const STOP_CIRCLE_STROKE_OPACITY = 0.75;
const STOP_TYPE_TOGGLE_SELECTOR = '[data-stop-type-toggle]';
const SYNCED_STORAGE_KEYS = new Set([
  ...SETTINGS_STORAGE_KEYS,
  WALKSHED_CACHE_RESET_MARKER_KEY,
  WALKSHED_DISABLED_STOPS_STORAGE_KEY,
]);

interface StopProperties {
  stopId: string;
  color: string;
  radius: number;
}

class TransitMapController {
  private readonly map: MapLibreMap;
  private readonly coverageInfoEl = document.querySelector<HTMLElement>('[data-coverage-info]');
  private readonly radiusInfoEl = document.querySelector<HTMLElement>('[data-radius-info]');
  private readonly walkshedLoadProgressEl = document.querySelector<HTMLElement>(
    '[data-walkshed-load-progress]',
  );
  private readonly walkshedProgressTextEl = document.querySelector<HTMLElement>(
    '[data-walkshed-progress-text]',
  );
  private readonly walkshedOverlay: WalkshedOverlayManager;
  private readonly stopTypeToggleButtons = new Map<StopType, HTMLButtonElement>();
  private readonly customMarkersById = new Map<string, Marker>();
  private readonly stopsById = new Map<string, Stop>();
  private radiusMetersByType: StopRadiusByType = getConfiguredStopRadii();
  private visibleStopTypes: StopTypeVisibilityByType = getConfiguredStopTypeVisibility();
  private coverageShape: CoverageShape = getConfiguredCoverageShape();
  private allowReasonableStreetCrossings = getAllowReasonableStreetCrossings();
  private walkshedDisabledStopIds = getWalkshedDisabledStopIds();
  private walkshedCacheResetMarker = getWalkshedCacheResetMarker();
  private stopLoadGeneration = 0;
  private suppressNextMapClick = false;

  constructor(map: MapLibreMap) {
    this.map = map;
    this.walkshedOverlay = new WalkshedOverlayManager({
      map,
      getRadiusMetersForType: (stopType) => this.radiusMetersByType[stopType],
      isEnabled: () => this.coverageShape === 'walkshed',
      getAllowReasonableStreetCrossings: () => this.allowReasonableStreetCrossings,
      onLoadProgressChange: (progress) => this.updateWalkshedLoadProgress(progress),
    });
    this.addStopLayers();
  }

  private addStopLayers(): void {
    this.map.addSource(RADIUS_SOURCE_ID, { type: 'geojson', data: emptyPolygonCollection() });
    this.map.addLayer({
      id: RADIUS_FILL_LAYER_ID,
      type: 'fill',
      source: RADIUS_SOURCE_ID,
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': STOP_CIRCLE_FILL_OPACITY },
    });
    this.map.addLayer({
      id: RADIUS_LINE_LAYER_ID,
      type: 'line',
      source: RADIUS_SOURCE_ID,
      paint: {
        'line-color': ['get', 'color'],
        'line-opacity': STOP_CIRCLE_STROKE_OPACITY,
        'line-width': 2,
      },
    });
    const emptyStops: FeatureCollection<Point, StopProperties> = {
      type: 'FeatureCollection',
      features: [],
    };
    this.map.addSource(STOP_SOURCE_ID, { type: 'geojson', data: emptyStops });
    this.map.addLayer({
      id: STOP_LAYER_ID,
      type: 'circle',
      source: STOP_SOURCE_ID,
      paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.8,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1,
      },
    });
  }

  init(): void {
    this.updateLegend();
    this.bindSettingsSync();
    this.bindStopTypeToggles();
    this.map.on('moveend', () => this.walkshedOverlay.onViewportChanged());
    this.map.on('click', STOP_LAYER_ID, (event) => {
      const stopId = event.features?.[0]?.properties?.stopId;
      if (typeof stopId !== 'string') return;
      const stop = this.stopsById.get(stopId);
      if (!stop) return;
      this.suppressNextMapClick = true;
      this.showStopPopup(stop);
      if (this.coverageShape === 'walkshed' && !this.walkshedDisabledStopIds.has(stop.id)) {
        this.walkshedOverlay.prioritizeStop(stop);
      }
      this.releaseMapClickSuppression();
    });
    this.map.on('mouseenter', STOP_LAYER_ID, () => (this.map.getCanvas().style.cursor = 'pointer'));
    this.map.on('mouseleave', STOP_LAYER_ID, () => (this.map.getCanvas().style.cursor = ''));
    this.map.on('click', (event) => {
      if (this.suppressNextMapClick) {
        this.suppressNextMapClick = false;
        return;
      }
      this.showAddStopPopup(event.lngLat);
    });
    void this.loadStops();
  }

  private updateWalkshedLoadProgress(progress: WalkshedLoadProgress): void {
    if (!this.walkshedLoadProgressEl) return;
    const visible = this.coverageShape === 'walkshed' && progress.total > 0;
    const complete = progress.pending === 0;
    this.walkshedLoadProgressEl.hidden = !visible;
    this.walkshedLoadProgressEl.ariaBusy = String(visible && !complete);
    this.walkshedLoadProgressEl.dataset.complete = String(complete);
    if (!visible) return;
    const unavailableText = progress.unavailable
      ? ` ${progress.unavailable} ${progress.unavailable === 1 ? 'Laufweite ist' : 'Laufweiten sind'} derzeit nicht verfügbar.`
      : '';
    if (!this.walkshedProgressTextEl) return;
    this.walkshedProgressTextEl.textContent = complete
      ? `${progress.loaded} von ${progress.total} Laufweiten geladen.${unavailableText}`
      : `Laufweiten werden berechnet (${progress.loaded} von ${progress.total}). Das kann etwas dauern.${unavailableText}`;
  }

  private allStops(): Stop[] {
    return [...this.stopsById.values()];
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
    } else {
      this.walkshedOverlay.addOrUpdateStop(stop);
    }
  }

  private updateLegend(): void {
    if (this.radiusInfoEl) {
      this.radiusInfoEl.textContent = `Radien: ${formatStopRadiusSummary(this.radiusMetersByType)}`;
    }
    if (this.coverageInfoEl) {
      this.coverageInfoEl.textContent = `Darstellung: ${COVERAGE_SHAPE_DISPLAY_LABELS[this.coverageShape]}`;
    }
  }

  private releaseMapClickSuppression(): void {
    window.setTimeout(() => (this.suppressNextMapClick = false), 0);
  }

  private popupElement(html: string): HTMLDivElement {
    const element = document.createElement('div');
    element.innerHTML = html;
    return element;
  }

  private showStopPopup(stop: Stop, marker?: Marker): Popup {
    const content = this.popupElement(
      createStopPopupHtml(stop, { walkshedDisabled: this.walkshedDisabledStopIds.has(stop.id) }),
    );
    const popup = new maplibregl.Popup({ offset: marker ? 20 : 8 })
      .setLngLat([stop.lon, stop.lat])
      .setDOMContent(content)
      .addTo(this.map);
    const toggleButton = content.querySelector<HTMLButtonElement>(
      STOP_WALKSHED_TOGGLE_BUTTON_SELECTOR,
    );
    if (toggleButton && !stop.isCustom) {
      this.updateWalkshedToggleButton(toggleButton, stop.id);
      toggleButton.addEventListener('click', (event) => {
        event.stopPropagation();
        const disabled = !this.walkshedDisabledStopIds.has(stop.id);
        setWalkshedDisabledForStop(stop.id, disabled);
        if (disabled) this.walkshedDisabledStopIds.add(stop.id);
        else this.walkshedDisabledStopIds.delete(stop.id);
        this.syncWalkshedForStop(stop);
        this.updateWalkshedToggleButton(toggleButton, stop.id);
      });
    }
    const removeButton = content.querySelector<HTMLButtonElement>(STOP_REMOVE_BUTTON_SELECTOR);
    if (removeButton && stop.isCustom) {
      removeButton.addEventListener('click', (event) => {
        event.stopPropagation();
        removeButton.disabled = true;
        removeButton.textContent = 'Entferne...';
        if (removeCustomStop(stop.id)) {
          void this.invalidateStopWalkshedCache(stop.id).catch(console.error);
          this.removeStop(stop.id);
          popup.remove();
        } else {
          removeButton.disabled = false;
          removeButton.textContent = 'Haltestelle entfernen';
        }
      });
    }
    return popup;
  }

  private updateWalkshedToggleButton(button: HTMLButtonElement, stopId: string): void {
    const disabled = this.walkshedDisabledStopIds.has(stopId);
    const label = getStopWalkshedToggleLabel(disabled);
    button.setAttribute('aria-pressed', disabled ? 'true' : 'false');
    button.setAttribute('aria-label', label);
    button.textContent = label;
  }

  private createCustomMarker(stop: Stop): Marker {
    const element = createCustomStopMarkerElement(stop.type, STOP_TYPE_CONFIG[stop.type].color);
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      this.suppressNextMapClick = true;
      this.showStopPopup(stop, marker);
      if (this.coverageShape === 'walkshed') this.walkshedOverlay.prioritizeStop(stop);
      this.releaseMapClickSuppression();
    });
    const marker = new maplibregl.Marker({ element, draggable: true })
      .setLngLat([stop.lon, stop.lat])
      .addTo(this.map);
    let dragStart = marker.getLngLat();
    marker.on('dragstart', () => {
      dragStart = marker.getLngLat();
      this.suppressNextMapClick = true;
      if (this.coverageShape === 'walkshed') this.walkshedOverlay.removeStop(stop.id);
    });
    marker.on('dragend', () => {
      void this.finishCustomStopDrag(stop, marker, dragStart);
    });
    return marker;
  }

  private async finishCustomStopDrag(stop: Stop, marker: Marker, dragStart: LngLat): Promise<void> {
    try {
      const position = marker.getLngLat();
      if (position.lng === dragStart.lng && position.lat === dragStart.lat) {
        this.syncWalkshedForStop(stop);
        return;
      }
      const updated = updateCustomStopPosition(stop.id, position.lat, position.lng);
      if (!updated) {
        marker.setLngLat(dragStart);
        this.syncWalkshedForStop(stop);
        return;
      }
      await this.invalidateStopWalkshedCache(stop.id).catch((error) =>
        console.error(`Failed to invalidate walkshed cache for ${stop.id}`, error),
      );
      this.addOrUpdateStop(updated);
      if (this.coverageShape === 'walkshed') this.walkshedOverlay.prioritizeStop(updated);
    } finally {
      this.releaseMapClickSuppression();
    }
  }

  private renderStopMarkers(): void {
    for (const marker of this.customMarkersById.values()) marker.remove();
    this.customMarkersById.clear();
    const stopFeatures: Feature<Point, StopProperties>[] = [];
    for (const stop of this.visibleStops()) {
      const color = STOP_TYPE_CONFIG[stop.type].color;
      if (stop.isCustom) this.customMarkersById.set(stop.id, this.createCustomMarker(stop));
      else {
        stopFeatures.push({
          type: 'Feature',
          properties: { stopId: stop.id, color, radius: STOP_TYPE_CONFIG[stop.type].markerRadius },
          geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
        });
      }
    }
    const stops: FeatureCollection<Point, StopProperties> = {
      type: 'FeatureCollection',
      features: stopFeatures,
    };
    (this.map.getSource(STOP_SOURCE_ID) as GeoJSONSource).setData(stops);
  }

  private renderRadiusCoverage(): void {
    const radiusFeatures =
      this.coverageShape === 'circle'
        ? this.visibleStops().map((stop) =>
            circlePolygon(
              stop.id,
              stop.lat,
              stop.lon,
              this.radiusMetersByType[stop.type],
              STOP_TYPE_CONFIG[stop.type].color,
            ),
          )
        : [];
    const radii: FeatureCollection<Polygon, PolygonFeature['properties']> = {
      type: 'FeatureCollection',
      features: radiusFeatures,
    };
    (this.map.getSource(RADIUS_SOURCE_ID) as GeoJSONSource).setData(radii);
  }

  private renderAllStops(): void {
    this.renderStopMarkers();
    this.renderRadiusCoverage();
  }

  private setStops(stops: Stop[]): void {
    this.stopsById.clear();
    for (const stop of stops) this.stopsById.set(stop.id, stop);
    this.renderAllStops();
    this.walkshedOverlay.setStops(this.walkshedVisibleStops());
  }

  private addOrUpdateStop(stop: Stop): void {
    this.stopsById.set(stop.id, stop);
    this.renderAllStops();
    this.syncWalkshedForStop(stop);
  }

  private removeStop(stopId: string): void {
    this.customMarkersById.get(stopId)?.remove();
    this.customMarkersById.delete(stopId);
    this.stopsById.delete(stopId);
    this.renderAllStops();
    this.walkshedOverlay.removeStop(stopId);
  }

  private async invalidateStopWalkshedCache(stopId: string): Promise<void> {
    invalidateWalkshedRuntimeCacheForStop(stopId);
    await removeCachedWalkshedPolygonsForStop(stopId);
    this.walkshedCacheResetMarker = getWalkshedCacheResetMarker();
  }

  private async loadStops(): Promise<void> {
    const generation = ++this.stopLoadGeneration;
    try {
      if (
        matchesShippedWalkshedDefaults(
          this.radiusMetersByType,
          this.coverageShape,
          this.allowReasonableStreetCrossings,
        )
      ) {
        // Warm only the visible types; hidden ones (bus by default) load lazily.
        void preloadShippedWalksheds(STOP_TYPES.filter((type) => this.visibleStopTypes[type]));
      }
      const stops = await loadAllStops();
      if (generation === this.stopLoadGeneration) this.setStops(stops);
    } catch (error) {
      if (generation === this.stopLoadGeneration) console.error('Failed to load stops:', error);
    }
  }

  private setRadii(radiusByType: StopRadiusByType): void {
    if (!stopTypeRecordChanged(radiusByType, this.radiusMetersByType)) return;
    this.radiusMetersByType = { ...radiusByType };
    this.renderRadiusCoverage();
    this.updateLegend();
    this.walkshedOverlay.onSettingsChanged();
  }

  private setCoverageShape(shape: CoverageShape): void {
    if (shape === this.coverageShape) return;
    this.coverageShape = shape;
    this.updateLegend();
    this.walkshedOverlay.onCoverageModeChanged(shape === 'walkshed');
    this.renderRadiusCoverage();
  }

  private setAllowReasonableStreetCrossings(allow: boolean): void {
    if (allow === this.allowReasonableStreetCrossings) return;
    this.allowReasonableStreetCrossings = allow;
    this.walkshedOverlay.onSettingsChanged();
  }

  private setWalkshedDisabledStopIds(next: Set<string>): void {
    const changed =
      next.size !== this.walkshedDisabledStopIds.size ||
      [...next].some((id) => !this.walkshedDisabledStopIds.has(id));
    if (!changed) return;
    this.walkshedDisabledStopIds = new Set(next);
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
    this.setAllowReasonableStreetCrossings(getAllowReasonableStreetCrossings());
    this.setRadii(getConfiguredStopRadii());
  }

  private bindSettingsSync(): void {
    const sync = () => this.syncSettingsFromStorage();
    window.addEventListener('focus', sync);
    window.addEventListener('pageshow', sync);
    window.addEventListener('storage', (event) => {
      if (event.key === CUSTOM_STOPS_STORAGE_KEY) void this.loadStops();
      else if (event.key && SYNCED_STORAGE_KEYS.has(event.key)) sync();
    });
  }

  private syncStopTypeToggleButtons(): void {
    for (const type of STOP_TYPES) {
      this.stopTypeToggleButtons
        .get(type)
        ?.setAttribute('aria-pressed', String(this.visibleStopTypes[type]));
    }
  }

  private setVisibleStopTypes(next: StopTypeVisibilityByType): void {
    const changed = stopTypeRecordChanged(next, this.visibleStopTypes);
    this.visibleStopTypes = { ...next };
    this.syncStopTypeToggleButtons();
    if (!changed) return;
    this.renderAllStops();
    this.walkshedOverlay.setStops(this.walkshedVisibleStops());
  }

  private bindStopTypeToggles(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>(STOP_TYPE_TOGGLE_SELECTOR)) {
      const type = button.dataset.stopTypeToggle;
      if (!isStopType(type)) continue;
      this.stopTypeToggleButtons.set(type, button);
      button.addEventListener('click', () => {
        this.setVisibleStopTypes(
          setConfiguredStopTypeVisibility({
            ...this.visibleStopTypes,
            [type]: !this.visibleStopTypes[type],
          }),
        );
      });
    }
    this.syncStopTypeToggleButtons();
  }

  private showAddStopPopup(lngLat: LngLat): void {
    const content = this.popupElement(createAddStopPopupHtml());
    const popup = new maplibregl.Popup().setLngLat(lngLat).setDOMContent(content).addTo(this.map);
    const form = content.querySelector<HTMLFormElement>(ADD_STOP_FORM_SELECTOR);
    const input = content.querySelector<HTMLInputElement>(ADD_STOP_NAME_SELECTOR);
    const typeInput = content.querySelector<HTMLSelectElement>(ADD_STOP_TYPE_SELECTOR);
    if (!form || !input || !typeInput) return;
    input.focus();
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name || !isStopType(typeInput.value)) return;
      this.addOrUpdateStop(
        addCustomStop({ name, type: typeInput.value, lat: lngLat.lat, lon: lngLat.lng }),
      );
      popup.remove();
    });
  }
}

export function initMap(): void {
  if (!document.getElementById(MAP_CONTAINER_ID)) return;
  const styleUrl = import.meta.env.PUBLIC_MAP_STYLE_URL || DEFAULT_MAP_STYLE_URL;
  const map = new maplibregl.Map({
    container: MAP_CONTAINER_ID,
    style: styleUrl,
    center: MAP_INITIAL_CENTER,
    zoom: MAP_INITIAL_ZOOM,
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  map.once('load', () => new TransitMapController(map).init());
}
