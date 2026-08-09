import type { Map as MapLibreMap } from 'maplibre-gl';

const RAILWAY_INFRASTRUCTURE_SOURCE_ID = 'railway-infrastructure';
export const RAILWAY_INFRASTRUCTURE_LAYER_ID = 'railway-infrastructure-overlay';
const OPEN_RAILWAY_MAP_TILE_URL = 'https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png';

const OPEN_RAILWAY_MAP_ATTRIBUTION =
  'Data <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>, ' +
  'Style: <a href="https://creativecommons.org/licenses/by-sa/2.0/">CC-BY-SA 2.0</a> ' +
  '<a href="https://www.openrailwaymap.org/">OpenRailwayMap</a>';

export function addRailwayInfrastructureOverlay(map: MapLibreMap, visible: boolean): void {
  map.addSource(RAILWAY_INFRASTRUCTURE_SOURCE_ID, {
    type: 'raster',
    tiles: [OPEN_RAILWAY_MAP_TILE_URL],
    tileSize: 256,
    maxzoom: 19,
    attribution: OPEN_RAILWAY_MAP_ATTRIBUTION,
  });
  map.addLayer({
    id: RAILWAY_INFRASTRUCTURE_LAYER_ID,
    type: 'raster',
    source: RAILWAY_INFRASTRUCTURE_SOURCE_ID,
    layout: { visibility: visible ? 'visible' : 'none' },
    paint: { 'raster-opacity': 0.8 },
  });
}

export function setRailwayInfrastructureOverlayVisible(map: MapLibreMap, visible: boolean): void {
  map.setLayoutProperty(
    RAILWAY_INFRASTRUCTURE_LAYER_ID,
    'visibility',
    visible ? 'visible' : 'none',
  );
}
