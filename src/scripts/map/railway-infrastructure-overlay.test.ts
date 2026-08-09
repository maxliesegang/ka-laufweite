import { describe, expect, it, vi } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  RAILWAY_INFRASTRUCTURE_LAYER_ID,
  addRailwayInfrastructureOverlay,
  setRailwayInfrastructureOverlayVisible,
} from './railway-infrastructure-overlay';

describe('railway infrastructure overlay', () => {
  it('adds the attributed OpenRailwayMap raster source hidden by default', () => {
    const addSource = vi.fn();
    const addLayer = vi.fn();
    const map = { addSource, addLayer } as unknown as MapLibreMap;

    addRailwayInfrastructureOverlay(map, false);

    expect(addSource).toHaveBeenCalledWith(
      'railway-infrastructure',
      expect.objectContaining({
        type: 'raster',
        tiles: ['https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: expect.stringContaining('OpenRailwayMap'),
      }),
    );
    expect(addLayer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: RAILWAY_INFRASTRUCTURE_LAYER_ID,
        type: 'raster',
        source: 'railway-infrastructure',
        layout: { visibility: 'none' },
      }),
    );
  });

  it('updates visibility without rebuilding the source or layer', () => {
    const setLayoutProperty = vi.fn();
    const map = { setLayoutProperty } as unknown as MapLibreMap;

    setRailwayInfrastructureOverlayVisible(map, true);

    expect(setLayoutProperty).toHaveBeenCalledWith(
      RAILWAY_INFRASTRUCTURE_LAYER_ID,
      'visibility',
      'visible',
    );
  });
});
