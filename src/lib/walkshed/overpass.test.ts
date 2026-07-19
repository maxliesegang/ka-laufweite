import { describe, expect, it } from 'vitest';
import { parseOverpassResponse } from './overpass';

describe('Overpass response validation', () => {
  it('accepts a valid empty response as valid no-data', () => {
    expect(parseOverpassResponse({ elements: [] })).toEqual({ elements: [] });
  });

  it('rejects partial or malformed element arrays', () => {
    expect(
      parseOverpassResponse({
        elements: [
          { type: 'node', id: 1, lat: 49, lon: 8 },
          { type: 'way', id: 2, nodes: ['invalid'] },
        ],
      }),
    ).toBeNull();
  });
});
