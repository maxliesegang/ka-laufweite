import { STOP_TYPE_LABELS } from './map-config';
import type { Stop } from './types';

export const STOP_REMOVE_BUTTON_SELECTOR = '[data-remove-stop-id]';
export const ADD_STOP_FORM_SELECTOR = '[data-add-stop-form]';
export const ADD_STOP_NAME_SELECTOR = '[data-stop-name-input]';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function createStopPopupHtml(stop: Stop): string {
  const base = `
    <div class="stop-popup">
      <strong>${escapeHtml(stop.name)}</strong>
      <em>${STOP_TYPE_LABELS[stop.type]}</em>
    </div>
  `;

  if (stop.type !== 'custom') {
    return base;
  }

  return `
    ${base}
    <button type="button" class="stop-popup__remove" data-remove-stop-id="${stop.id}">
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
      <button class="stop-popup-form__submit" type="submit">
        Hinzufügen
      </button>
    </form>
  `;
}
