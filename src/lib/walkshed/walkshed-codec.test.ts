import { describe, expect, it } from 'vitest';
import {
  WALKSHED_DATA_PRECISION,
  WALKSHED_DATA_VERSION,
  decodeWalkshedPolygon,
  encodeWalkshedPolygon,
  parseWalkshedDataset,
  partitionWalkshedDatasetByType,
  shippedWalkshedDataPath,
  walkshedDatasetPolygonKey,
  type WalkshedDataset,
} from './walkshed-codec';
import type { LatLng } from './types';

describe('walkshed codec', () => {
  it('round-trips a polygon within the precision tolerance', () => {
    const polygon: LatLng[] = [
      [49.009412, 8.404321],
      [49.010877, 8.406654],
      [49.008003, 8.407991],
      [49.006512, 8.403118],
    ];

    const decoded = decodeWalkshedPolygon(encodeWalkshedPolygon(polygon));

    expect(decoded).toHaveLength(polygon.length);
    const tolerance = 1 / WALKSHED_DATA_PRECISION;
    for (let i = 0; i < polygon.length; i += 1) {
      expect(Math.abs(decoded[i][0] - polygon[i][0])).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(decoded[i][1] - polygon[i][1])).toBeLessThanOrEqual(tolerance);
    }
  });

  it('stores the first point absolute and the rest as deltas', () => {
    const encoded = encodeWalkshedPolygon(
      [
        [49.0, 8.0],
        [49.00002, 8.00003],
      ],
      100_000,
    );

    expect(encoded).toEqual([4_900_000, 800_000, 2, 3]);
  });

  it('returns an empty polygon for empty input', () => {
    expect(decodeWalkshedPolygon(encodeWalkshedPolygon([]))).toEqual([]);
  });

  it('keys polygons by stop identity and snapshot attributes', () => {
    expect(walkshedDatasetPolygonKey({ id: 'osm-1', type: 'tram', lat: 49.1, lon: 8.2 })).toBe(
      'osm-1:tram:49.1:8.2',
    );
  });

  it('validates complete datasets', () => {
    const polygon = encodeWalkshedPolygon([
      [49, 8],
      [49.001, 8],
      [49, 8.001],
    ]);
    const dataset = {
      version: WALKSHED_DATA_VERSION,
      generatedAt: '2026-07-19T12:00:00.000Z',
      precision: WALKSHED_DATA_PRECISION,
      allowReasonableStreetCrossings: true,
      radiusByType: { train: 400, tram: 300, bus: 200 },
      polygons: { 'osm-1:tram:49:8': polygon },
    };

    expect(parseWalkshedDataset(dataset)).toBe(dataset);
    expect(parseWalkshedDataset({ ...dataset, version: 999 })).toBeNull();
    expect(
      parseWalkshedDataset({ ...dataset, polygons: { 'osm-1:tram:49:8': [1, 2, 3] } }),
    ).toBeNull();
  });

  it('derives the shipped data path per stop type', () => {
    expect(shippedWalkshedDataPath('bus', 200)).toBe('data/walksheds-bus-200.json');
    expect(shippedWalkshedDataPath('train', 450)).toBe('data/walksheds-train-450.json');
  });

  it('partitions a combined dataset into one dataset per stop type', () => {
    const polygon = encodeWalkshedPolygon([
      [49, 8],
      [49.001, 8],
      [49, 8.001],
    ]);
    const dataset: WalkshedDataset = {
      version: WALKSHED_DATA_VERSION,
      generatedAt: '2026-07-19T12:00:00.000Z',
      precision: WALKSHED_DATA_PRECISION,
      allowReasonableStreetCrossings: true,
      radiusByType: { train: 400, tram: 300, bus: 200 },
      polygons: {
        'osm-1:tram:49:8': polygon,
        'osm-2:bus:49:8': polygon,
        'osm-3:bus:49:8': polygon,
      },
    };

    const byType = partitionWalkshedDatasetByType(dataset);

    expect(Object.keys(byType.tram.polygons)).toEqual(['osm-1:tram:49:8']);
    expect(Object.keys(byType.bus.polygons)).toEqual(['osm-2:bus:49:8', 'osm-3:bus:49:8']);
    expect(byType.train.polygons).toEqual({});
    // Shared metadata is preserved so each file validates on its own.
    expect(parseWalkshedDataset(byType.bus)).not.toBeNull();
    expect(byType.bus.radiusByType).toEqual(dataset.radiusByType);
  });
});
