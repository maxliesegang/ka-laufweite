import {
  DEFAULT_COVERAGE_SHAPE,
  DEFAULT_STOP_RADIUS_METERS_BY_TYPE,
  MAX_STOP_RADIUS_METERS,
  MIN_STOP_RADIUS_METERS,
  STOP_RADIUS_INPUT_IDS,
  STOP_RADIUS_STEP_METERS,
  type CoverageShape,
  type StopRadiusByType,
  COVERAGE_SHAPE_COMPACT_LABELS,
  getConfiguredCoverageShape,
  getConfiguredStopRadii,
  setConfiguredCoverageShape,
  setConfiguredStopRadius,
} from '../lib/settings';
import {
  formatStopRadiusSummary,
  STOP_TYPE_CONFIG,
  STOP_TYPES_CONFIG_ORDER,
} from '../lib/stop-type-config';
import { mapStopTypes, stopTypeRecordChanged, type StopType } from '../lib/types';
import { clearCustomStops } from '../lib/custom-stops-client';
import { clearWalkshedDisabledStops } from '../lib/walkshed-disabled-stops';
import {
  clearWalkshedCache,
  getWalkshedCacheSize,
  removeCachedWalkshedPolygonsForStops,
} from '../lib/walkshed-cache';

const AUTOSAVE_DEBOUNCE_MS = 800;

function requireElement<T extends HTMLElement>(id: string, type: new (...args: never[]) => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`Missing element #${id}`);
  return el;
}

function statusText(prefix: string, radii: StopRadiusByType, shape: CoverageShape): string {
  return `${prefix}: ${formatStopRadiusSummary(radii, STOP_TYPES_CONFIG_ORDER)}, ${COVERAGE_SHAPE_COMPACT_LABELS[shape]}`;
}

function invalidRadiusHint(invalidTypes: StopType[]): string {
  if (invalidTypes.length === 0) return '';
  const labels = invalidTypes.map((stopType) => STOP_TYPE_CONFIG[stopType].compactLabel).join(', ');
  return ` Ungültig und unverändert: ${labels}.`;
}

export function initConfigPage(): void {
  let radiusInputs: Record<StopType, HTMLInputElement>;
  let shapeSelect: HTMLSelectElement;
  let resetDefaultsBtn: HTMLButtonElement;
  let deleteCustomStopsBtn: HTMLButtonElement;
  let resetCacheBtn: HTMLButtonElement;
  let saveStatus: HTMLParagraphElement;
  let cacheStatus: HTMLParagraphElement;

  try {
    radiusInputs = mapStopTypes((stopType) =>
      requireElement(STOP_RADIUS_INPUT_IDS[stopType], HTMLInputElement),
    );
    shapeSelect = requireElement('coverage-shape', HTMLSelectElement);
    resetDefaultsBtn = requireElement('reset-radius', HTMLButtonElement);
    deleteCustomStopsBtn = requireElement('delete-custom-stops', HTMLButtonElement);
    resetCacheBtn = requireElement('reset-walkshed-cache', HTMLButtonElement);
    saveStatus = requireElement('save-status', HTMLParagraphElement);
    cacheStatus = requireElement('cache-status', HTMLParagraphElement);
  } catch {
    return;
  }

  let autosaveTimer: number | null = null;
  let currentRadiusByType = getConfiguredStopRadii();
  let currentShape = getConfiguredCoverageShape();

  for (const stopType of STOP_TYPES_CONFIG_ORDER) {
    radiusInputs[stopType].value = String(currentRadiusByType[stopType]);
  }

  shapeSelect.value = currentShape;
  cacheStatus.textContent = `Polygon-Cache Einträge: ${getWalkshedCacheSize()}`;
  saveStatus.textContent = statusText('Automatisch aktiv', currentRadiusByType, currentShape);

  const clearTimer = () => {
    if (autosaveTimer !== null) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
  };

  const updateCacheStatus = () => {
    cacheStatus.textContent = `Polygon-Cache Einträge: ${getWalkshedCacheSize()}`;
  };

  const persistSettings = (prefix: string, normalizeRadius = false): void => {
    const nextRadiusByType: StopRadiusByType = { ...currentRadiusByType };
    const invalidTypes: StopType[] = [];

    for (const stopType of STOP_TYPES_CONFIG_ORDER) {
      const input = radiusInputs[stopType];
      const canSaveRadius = normalizeRadius || input.validity.valid;

      if (canSaveRadius) {
        nextRadiusByType[stopType] = setConfiguredStopRadius(stopType, input.value);
      } else {
        invalidTypes.push(stopType);
      }
    }

    const shape = setConfiguredCoverageShape(shapeSelect.value);

    for (const stopType of STOP_TYPES_CONFIG_ORDER) {
      radiusInputs[stopType].value = String(nextRadiusByType[stopType]);
    }
    shapeSelect.value = shape;

    const changed =
      stopTypeRecordChanged(nextRadiusByType, currentRadiusByType, STOP_TYPES_CONFIG_ORDER) ||
      shape !== currentShape;

    currentRadiusByType = nextRadiusByType;
    currentShape = shape;

    const allInvalid = invalidTypes.length === STOP_TYPES_CONFIG_ORDER.length;
    if (allInvalid && !changed) {
      saveStatus.textContent =
        `Jeder Radius muss zwischen ${MIN_STOP_RADIUS_METERS} m und ${MAX_STOP_RADIUS_METERS} m ` +
        `in ${STOP_RADIUS_STEP_METERS} m Schritten liegen.`;
      return;
    }

    if (changed) {
      clearWalkshedCache();
      updateCacheStatus();
      saveStatus.textContent =
        statusText(`${prefix} (Cache zurückgesetzt)`, nextRadiusByType, shape) +
        invalidRadiusHint(invalidTypes);
    } else {
      saveStatus.textContent =
        statusText(prefix, nextRadiusByType, shape) + invalidRadiusHint(invalidTypes);
    }
  };

  const scheduleAutosave = () => {
    clearTimer();
    autosaveTimer = window.setTimeout(() => {
      autosaveTimer = null;
      persistSettings('Automatisch gespeichert');
    }, AUTOSAVE_DEBOUNCE_MS);
  };

  for (const stopType of STOP_TYPES_CONFIG_ORDER) {
    radiusInputs[stopType].addEventListener('input', scheduleAutosave);
    radiusInputs[stopType].addEventListener('blur', () => {
      clearTimer();
      persistSettings('Automatisch gespeichert', true);
    });
  }

  shapeSelect.addEventListener('change', () => {
    clearTimer();
    persistSettings('Automatisch gespeichert');
  });

  resetDefaultsBtn.addEventListener('click', () => {
    clearTimer();
    for (const stopType of STOP_TYPES_CONFIG_ORDER) {
      radiusInputs[stopType].value = String(DEFAULT_STOP_RADIUS_METERS_BY_TYPE[stopType]);
    }
    shapeSelect.value = DEFAULT_COVERAGE_SHAPE;
    persistSettings('Standardwerte übernommen', true);
  });

  deleteCustomStopsBtn.addEventListener('click', () => {
    clearTimer();

    const removedStops = clearCustomStops();
    const resetWalkshedPolygons = clearWalkshedDisabledStops();

    const removedPolygons =
      removedStops.length === 0
        ? 0
        : removeCachedWalkshedPolygonsForStops(removedStops.map((stop) => stop.id));
    updateCacheStatus();

    if (removedStops.length === 0 && resetWalkshedPolygons === 0) {
      saveStatus.textContent =
        'Keine eigenen Haltestellen oder ausgeblendeten Fussweg-Polygone vorhanden.';
      return;
    }

    const statusParts: string[] = [];
    if (removedStops.length > 0) {
      statusParts.push(`Eigene Haltestellen geloescht: ${removedStops.length}.`);
      if (removedPolygons > 0) {
        statusParts.push(`Zugehoerige Polygon-Cache-Eintraege geloescht: ${removedPolygons}.`);
      } else {
        statusParts.push('Keine zugehoerigen Polygon-Cache-Eintraege vorhanden.');
      }
    }

    if (resetWalkshedPolygons > 0) {
      statusParts.push(`Ausgeblendete Fussweg-Polygone zurueckgesetzt: ${resetWalkshedPolygons}.`);
    }

    saveStatus.textContent = statusParts.join(' ');
  });

  resetCacheBtn.addEventListener('click', () => {
    clearTimer();
    clearWalkshedCache();
    updateCacheStatus();
    saveStatus.textContent = 'Polygon-Cache wurde gelöscht. Einstellungen bleiben unverändert.';
  });
}
