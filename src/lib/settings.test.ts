import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS,
  DEFAULT_COVERAGE_SHAPE,
  DEFAULT_STOP_RADIUS_METERS_BY_TYPE,
  SHIPPED_STOP_RADII_METERS_BY_TYPE,
  matchesShippedWalkshedConfiguration,
} from './settings';
import { STOP_TYPES } from './types';

describe('shipped walkshed configuration', () => {
  it('recognizes the default and additional shipped radii', () => {
    expect(
      matchesShippedWalkshedConfiguration(
        { train: 400, tram: 300, bus: 200 },
        DEFAULT_COVERAGE_SHAPE,
        DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS,
      ),
    ).toBe(true);
    for (const stopType of STOP_TYPES) {
      for (const radiusMeters of SHIPPED_STOP_RADII_METERS_BY_TYPE[stopType]) {
        expect(
          matchesShippedWalkshedConfiguration(
            { ...DEFAULT_STOP_RADIUS_METERS_BY_TYPE, [stopType]: radiusMeters },
            DEFAULT_COVERAGE_SHAPE,
            DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS,
          ),
        ).toBe(true);
      }
    }
  });

  it('rejects radii and calculation settings without shipped polygons', () => {
    const unsupportedTrainRadius = Math.max(...SHIPPED_STOP_RADII_METERS_BY_TYPE.train) + 1;
    expect(
      matchesShippedWalkshedConfiguration(
        { ...DEFAULT_STOP_RADIUS_METERS_BY_TYPE, train: unsupportedTrainRadius },
        DEFAULT_COVERAGE_SHAPE,
        DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS,
      ),
    ).toBe(false);
    expect(
      matchesShippedWalkshedConfiguration(
        { train: 400, tram: 300, bus: 200 },
        DEFAULT_COVERAGE_SHAPE,
        false,
      ),
    ).toBe(false);
  });
});
