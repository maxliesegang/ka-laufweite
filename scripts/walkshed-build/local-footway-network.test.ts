import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FOOTWAY_EXTRACT_FILENAME,
  FOOTWAY_EXTRACT_METADATA_FILENAME,
  loadLocalFootwayNetwork,
  segmentIntersectsBounds,
  type FootwayExtractMetadata,
} from './local-footway-network.ts';

const EXTRACT_BOUNDS = { south: 48, west: 8, north: 50, east: 9 };
const QUERY_BOUNDS = { south: 49, west: 8.4, north: 49.1, east: 8.5 };

// Nodes 1–2: inside the query box. Nodes 3–4: outside on opposite sides, so
// the segment 3→4 crosses the box without a node inside it. Nodes 5–6: far away.
const OPL_LINES = [
  'n1 T x8.41 y49.01',
  'n2 T x8.42 y49.02',
  'n3 T x8.35 y49.05',
  'n4 T x8.55 y49.05',
  'n5 T x8.8 y49.5',
  'n6 T x8.81 y49.51',
  'n7 T x8.43 y49.03',
  'w10 Thighway=footway,name=Kaiser%20%stra%df%e Nn1,n2',
  'w11 Thighway=residential Nn3,n4',
  'w12 Thighway=footway Nn5,n6',
  'w13 Thighway=motorway Nn1,n7',
  'w14 Thighway=service,access=private Nn2,n7',
  'w15 Thighway=path,foot=designated Nn2,n7',
];

let cacheDir: string | null = null;

async function writeExtract(lines: string[]): Promise<string> {
  cacheDir = await mkdtemp(join(tmpdir(), 'footway-extract-'));
  const metadata: FootwayExtractMetadata = {
    bounds: EXTRACT_BOUNDS,
    regions: ['test'],
    generatedAt: '2026-10-01T00:00:00.000Z',
  };
  await writeFile(join(cacheDir, FOOTWAY_EXTRACT_FILENAME), `${lines.join('\n')}\n`);
  await writeFile(join(cacheDir, FOOTWAY_EXTRACT_METADATA_FILENAME), JSON.stringify(metadata));
  return cacheDir;
}

afterEach(async () => {
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
  cacheDir = null;
});

describe('local footway network', () => {
  it('answers a bounds query like the runtime Overpass query', async () => {
    const network = await loadLocalFootwayNetwork(await writeExtract(OPL_LINES));
    const { elements } = network.footwayNetworkInBounds(QUERY_BOUNDS);

    expect(elements.map((element) => `${element.type[0]}${element.id}`)).toEqual([
      'n1',
      'n2',
      'n3',
      'n4',
      'n7',
      'w10',
      'w11',
      'w15',
    ]);
    expect(elements.find((element) => element.id === 10)).toMatchObject({
      type: 'way',
      nodes: [1, 2],
      tags: { highway: 'footway', name: 'Kaiser straße' },
    });
    expect(elements.find((element) => element.id === 4)).toEqual({
      type: 'node',
      id: 4,
      lat: 49.05,
      lon: 8.55,
    });
  });

  it('refuses bounds that leave the extract instead of truncating the network', async () => {
    const network = await loadLocalFootwayNetwork(await writeExtract(OPL_LINES));

    expect(() => network.footwayNetworkInBounds({ ...QUERY_BOUNDS, north: 50.5 })).toThrow(
      /leave the OSM extract/,
    );
  });

  it('counts way references to nodes missing from the extract', async () => {
    const network = await loadLocalFootwayNetwork(
      await writeExtract([
        'n1 T x8.41 y49.01',
        'n2 T x8.42 y49.02',
        'w10 Thighway=footway Nn1,n2,n99',
      ]),
    );

    expect(network.missingNodeReferenceCount).toBe(1);
    expect(network.footwayNetworkInBounds(QUERY_BOUNDS).elements).toHaveLength(3);
  });

  it('rejects an extract whose nodes are not sorted by id', async () => {
    await expect(
      loadLocalFootwayNetwork(await writeExtract(['n2 T x8.42 y49.02', 'n1 T x8.41 y49.01'])),
    ).rejects.toThrow(/not sorted/);
  });
});

describe('segment and bounds intersection', () => {
  const bounds = { south: 0, west: 0, north: 1, east: 1 };

  it.each([
    ['crosses the box', [0.5, -1, 0.5, 2], true],
    ['ends inside the box', [0.5, -1, 0.5, 0.5], true],
    ['touches an edge', [1, -1, 1, 2], true],
    ['passes beside the box', [2, -1, 2, 2], false],
    ['passes a corner diagonally', [2.1, 0.5, 0.5, 2.1], false],
  ] as const)('%s', (_description, [fromLat, fromLon, toLat, toLon], expected) => {
    expect(segmentIntersectsBounds(fromLat, fromLon, toLat, toLon, bounds)).toBe(expected);
  });
});
