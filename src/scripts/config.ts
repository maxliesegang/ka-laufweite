import {
  DEFAULT_COVERAGE_SHAPE,
  DEFAULT_STOP_RADIUS_METERS,
  MAX_STOP_RADIUS_METERS,
  MIN_STOP_RADIUS_METERS,
  STOP_RADIUS_STEP_METERS,
  type CoverageShape,
  COVERAGE_SHAPE_COMPACT_LABELS,
  getConfiguredCoverageShape,
  getConfiguredStopRadius,
  setConfiguredCoverageShape,
  setConfiguredStopRadius,
} from '../lib/settings';
import { clearWalkshedCache, getWalkshedCacheSize } from '../lib/walkshed-cache';

const AUTOSAVE_DEBOUNCE_MS = 800;

function requireElement<T extends HTMLElement>(id: string, type: new (...args: never[]) => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`Missing element #${id}`);
  return el;
}

function statusText(prefix: string, radius: number, shape: CoverageShape): string {
  return `${prefix}: ${radius} m, ${COVERAGE_SHAPE_COMPACT_LABELS[shape]}`;
}

export function initConfigPage(): void {
  let input: HTMLInputElement;
  let shapeSelect: HTMLSelectElement;
  let resetDefaultsBtn: HTMLButtonElement;
  let resetCacheBtn: HTMLButtonElement;
  let saveStatus: HTMLParagraphElement;
  let cacheStatus: HTMLParagraphElement;

  try {
    input = requireElement('radius-input', HTMLInputElement);
    shapeSelect = requireElement('coverage-shape', HTMLSelectElement);
    resetDefaultsBtn = requireElement('reset-radius', HTMLButtonElement);
    resetCacheBtn = requireElement('reset-walkshed-cache', HTMLButtonElement);
    saveStatus = requireElement('save-status', HTMLParagraphElement);
    cacheStatus = requireElement('cache-status', HTMLParagraphElement);
  } catch {
    return;
  }

  let autosaveTimer: number | null = null;
  let currentRadius = getConfiguredStopRadius();
  let currentShape = getConfiguredCoverageShape();

  input.value = String(currentRadius);
  shapeSelect.value = currentShape;
  cacheStatus.textContent = `Polygon-Cache Einträge: ${getWalkshedCacheSize()}`;
  saveStatus.textContent = statusText('Automatisch aktiv', currentRadius, currentShape);

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
    const canSaveRadius = normalizeRadius || input.validity.valid;
    const radius = canSaveRadius ? setConfiguredStopRadius(input.value) : currentRadius;
    const shape = setConfiguredCoverageShape(shapeSelect.value);

    input.value = String(radius);
    shapeSelect.value = shape;

    const changed = radius !== currentRadius || shape !== currentShape;
    currentRadius = radius;
    currentShape = shape;

    if (!canSaveRadius && !changed) {
      saveStatus.textContent = `Radius muss zwischen ${MIN_STOP_RADIUS_METERS} m und ${MAX_STOP_RADIUS_METERS} m in ${STOP_RADIUS_STEP_METERS} m Schritten liegen.`;
      return;
    }

    const hint = canSaveRadius ? '' : ' Radius unverändert (ungültiger Wert).';

    if (changed) {
      clearWalkshedCache();
      updateCacheStatus();
      saveStatus.textContent = statusText(`${prefix} (Cache zurückgesetzt).${hint}`, radius, shape);
    } else {
      saveStatus.textContent = statusText(`${prefix}.${hint}`, radius, shape);
    }
  };

  const scheduleAutosave = () => {
    clearTimer();
    autosaveTimer = window.setTimeout(() => {
      autosaveTimer = null;
      persistSettings('Automatisch gespeichert');
    }, AUTOSAVE_DEBOUNCE_MS);
  };

  input.addEventListener('input', scheduleAutosave);
  input.addEventListener('blur', () => {
    clearTimer();
    persistSettings('Automatisch gespeichert', true);
  });
  shapeSelect.addEventListener('change', () => {
    clearTimer();
    persistSettings('Automatisch gespeichert');
  });

  resetDefaultsBtn.addEventListener('click', () => {
    clearTimer();
    input.value = String(DEFAULT_STOP_RADIUS_METERS);
    shapeSelect.value = DEFAULT_COVERAGE_SHAPE;
    persistSettings('Standardwerte übernommen', true);
  });

  resetCacheBtn.addEventListener('click', () => {
    clearTimer();
    clearWalkshedCache();
    updateCacheStatus();
    saveStatus.textContent = 'Polygon-Cache wurde gelöscht. Einstellungen bleiben unverändert.';
  });
}
