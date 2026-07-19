import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS,
  DEFAULT_COVERAGE_SHAPE,
  matchesShippedWalkshedConfiguration,
} from './settings';

describe('shipped walkshed configuration', () => {
  it('recognizes the default and additional train/tram radii', () => {
    expect(
      matchesShippedWalkshedConfiguration(
        { train: 400, tram: 300, bus: 200 },
        DEFAULT_COVERAGE_SHAPE,
        DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS,
      ),
    ).toBe(true);
    expect(
      matchesShippedWalkshedConfiguration(
        { train: 500, tram: 350, bus: 200 },
        DEFAULT_COVERAGE_SHAPE,
        DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS,
      ),
    ).toBe(true);
  });

  it('rejects radii and calculation settings without shipped polygons', () => {
    expect(
      matchesShippedWalkshedConfiguration(
        { train: 550, tram: 300, bus: 200 },
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
