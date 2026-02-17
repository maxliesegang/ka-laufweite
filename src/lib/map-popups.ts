import { STOP_TYPE_CONFIG, STOP_TYPE_ENTRIES } from './stop-type-config';
import type { Stop } from './types';

export const STOP_REMOVE_BUTTON_SELECTOR = '[data-remove-stop-id]';
export const STOP_WALKSHED_TOGGLE_BUTTON_SELECTOR = '[data-toggle-walkshed-stop-id]';
export const ADD_STOP_FORM_SELECTOR = '[data-add-stop-form]';
export const ADD_STOP_NAME_SELECTOR = '[data-stop-name-input]';
export const ADD_STOP_TYPE_SELECTOR = '[data-stop-type-input]';
const ADD_STOP_TYPE_OPTIONS = STOP_TYPE_ENTRIES.map(
  (stopType) => `<option value="${stopType.type}">${stopType.label}</option>`,
).join('');

interface StopPopupOptions {
  walkshedDisabled?: boolean;
}

export function getStopWalkshedToggleLabel(walkshedDisabled: boolean): string {
  return walkshedDisabled
    ? 'Fussweg-Polygon hier wieder anzeigen'
    : 'Fussweg-Polygon hier ausblenden';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function createStopPopupHtml(stop: Stop, options: StopPopupOptions = {}): string {
  const typeLabel = STOP_TYPE_CONFIG[stop.type].label;
  const details = stop.isCustom ? `${typeLabel} (Eigene Haltestelle)` : typeLabel;
  const escapedStopId = escapeHtml(stop.id);
  const base = `
    <div class="stop-popup">
      <strong>${escapeHtml(stop.name)}</strong>
      <em>${details}</em>
    </div>
  `;

  if (!stop.isCustom) {
    const walkshedDisabled = options.walkshedDisabled === true;
    const walkshedToggleLabel = getStopWalkshedToggleLabel(walkshedDisabled);

    return `
      ${base}
      <button
        type="button"
        class="stop-popup__walkshed-toggle"
        data-toggle-walkshed-stop-id="${escapedStopId}"
        aria-pressed="${walkshedDisabled ? 'true' : 'false'}"
        aria-label="${walkshedToggleLabel}"
      >
        ${walkshedToggleLabel}
      </button>
    `;
  }

  return `
    ${base}
    <button type="button" class="stop-popup__remove" data-remove-stop-id="${escapedStopId}">
      Haltestelle entfernen
    </button>
  `;
}

export function createAddStopPopupHtml(): string {
  return `
    <form data-add-stop-form class="stop-popup-form">
      <label class="stop-popup-form__label">Neue Haltestelle</label>
      <input
        data-stop-name-input
        class="stop-popup-form__input"
        type="text"
        placeholder="Name der Haltestelle"
        required
      />
      <label class="stop-popup-form__label" for="stop-type-select">Typ</label>
      <select data-stop-type-input id="stop-type-select" class="stop-popup-form__select" required>
        ${ADD_STOP_TYPE_OPTIONS}
      </select>
      <button class="stop-popup-form__submit" type="submit">
        Hinzufügen
      </button>
    </form>
  `;
}
