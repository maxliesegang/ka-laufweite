import { describe, expect, it } from 'vitest';

import { SHIPPED_STOP_RADII_METERS_BY_TYPE } from '../../src/lib/settings.ts';
import { STOP_TYPES } from '../../src/lib/types.ts';
import { DEFAULT_CONCURRENCY, parseBuildOptions } from './options.ts';

const OUT_DIR = '/tmp/walksheds';

describe('walkshed build options', () => {
  it('defaults to every stop type with its full shipped radius set', () => {
    const options = parseBuildOptions([], OUT_DIR);

    expect(options.stopTypes).toEqual([...STOP_TYPES]);
    expect(options.radiiByStopType).toEqual(SHIPPED_STOP_RADII_METERS_BY_TYPE);
    expect(options.concurrency).toBe(DEFAULT_CONCURRENCY);
    expect(options.stopLimit).toBe(Number.POSITIVE_INFINITY);
    expect(options.outDir).toBe(OUT_DIR);
    expect(options.progressFile).toBeNull();
    expect(options.diagnosticsFile).toBeNull();
  });

  it('reads every supported option', () => {
    const options = parseBuildOptions(
      [
        '--types',
        'tram',
        '--concurrency',
        '4',
        '--limit',
        '10',
        '--out-dir',
        '/elsewhere',
        '--progress-file',
        'progress.txt',
        '--diagnostics-file',
        'diagnostics.json',
      ],
      OUT_DIR,
    );

    expect(options).toMatchObject({
      stopTypes: ['tram'],
      concurrency: 4,
      stopLimit: 10,
      outDir: '/elsewhere',
      progressFile: 'progress.txt',
      diagnosticsFile: 'diagnostics.json',
    });
  });

  it('de-duplicates types and keeps canonical order for stable output', () => {
    const requested = [...STOP_TYPES].reverse();
    const options = parseBuildOptions(['--types', [...requested, requested[0]].join(',')], OUT_DIR);

    expect(options.stopTypes).toEqual([...STOP_TYPES]);
  });

  it('narrows the single requested type to one radius', () => {
    const [radiusMeters] = SHIPPED_STOP_RADII_METERS_BY_TYPE.tram;
    const options = parseBuildOptions(
      ['--types', 'tram', '--radius', String(radiusMeters)],
      OUT_DIR,
    );

    expect(options.radiiByStopType.tram).toEqual([radiusMeters]);
  });

  it.each([
    ['--radius without exactly one type', ['--radius', '600']],
    [
      'an unconfigured radius',
      [
        '--types',
        'tram',
        '--radius',
        String(Math.max(...SHIPPED_STOP_RADII_METERS_BY_TYPE.tram) + 1),
      ],
    ],
    ['an unknown stop type', ['--types', 'hovercraft']],
    ['an empty type list', ['--types', '']],
    ['a zero concurrency', ['--concurrency', '0']],
    ['a negative limit', ['--limit', '-1']],
    ['an unknown option', ['--nope', 'value']],
    ['a missing value', ['--types']],
    ['a value that looks like an option', ['--out-dir', '--types']],
  ])('rejects %s', (_description, args) => {
    expect(() => parseBuildOptions(args, OUT_DIR)).toThrow();
  });
});
