/**
 * Download the Geofabrik regions covering the stop area and reduce them to the
 * highway ways (plus their nodes) inside FOOTWAY_EXTRACT_BOUNDS, written as OPL
 * text for `scripts/build-walksheds.ts`. Requires curl and osmium-tool on PATH
 * (`apt-get install osmium-tool`, `brew install osmium-tool`).
 *
 *   npm run prepare:osm-extract -- [--cache-dir path]
 *
 * Downloads are reused when present; delete the cache directory to refresh.
 * The precise walkable-way filter runs in the build, so this step only needs
 * the coarse `w/highway` selection osmium can express.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FOOTWAY_EXTRACT_BOUNDS, GEOFABRIK_REGIONS } from './osm-area.ts';
import {
  DEFAULT_OSM_CACHE_DIR,
  FOOTWAY_EXTRACT_FILENAME,
  FOOTWAY_EXTRACT_METADATA_FILENAME,
  type FootwayExtractMetadata,
} from './walkshed-build/local-footway-network.ts';

const GEOFABRIK_BASE_URL = 'https://download.geofabrik.de';

function parseCacheDir(args: string[]): string {
  if (args.length === 0) return DEFAULT_OSM_CACHE_DIR;
  if (args.length === 2 && args[0] === '--cache-dir') return args[1];
  throw new Error(`Usage: prepare-osm-extract [--cache-dir path], received ${args.join(' ')}`);
}

function osmium(args: string[]): void {
  console.log(`  osmium ${args.join(' ')}`);
  execFileSync('osmium', args, { stdio: 'inherit' });
}

async function download(url: string, path: string): Promise<void> {
  if (existsSync(path)) {
    console.log(`  reusing ${path}`);
    return;
  }
  console.log(`  downloading ${url}`);
  // Write to a temporary name so an interrupted download is never reused.
  const partialPath = `${path}.partial`;
  execFileSync(
    'curl',
    [
      '--fail',
      '--location',
      '--retry',
      '3',
      '--silent',
      '--show-error',
      '--output',
      partialPath,
      url,
    ],
    {
      stdio: 'inherit',
    },
  );
  await rename(partialPath, path);
}

async function main(): Promise<void> {
  const cacheDir = parseCacheDir(process.argv.slice(2));
  await mkdir(cacheDir, { recursive: true });

  const highwayPaths: string[] = [];
  for (const region of GEOFABRIK_REGIONS) {
    const slug = region.replaceAll('/', '-');
    const regionPath = join(cacheDir, `${slug}.osm.pbf`);
    await download(`${GEOFABRIK_BASE_URL}/${region}-latest.osm.pbf`, regionPath);

    const highwayPath = join(cacheDir, `${slug}-highways.osm.pbf`);
    osmium(['tags-filter', regionPath, 'w/highway', '--overwrite', '-o', highwayPath]);
    highwayPaths.push(highwayPath);
  }

  // Neighbouring regions overlap at their borders; merge de-duplicates them.
  const mergedPath = join(cacheDir, 'highways.osm.pbf');
  osmium(['merge', ...highwayPaths, '--overwrite', '-o', mergedPath]);

  const { south, west, north, east } = FOOTWAY_EXTRACT_BOUNDS;
  osmium([
    'extract',
    '--bbox',
    [west, south, east, north].join(','),
    '--strategy',
    'complete_ways',
    mergedPath,
    '--overwrite',
    '-f',
    'opl,add_metadata=false',
    '-o',
    join(cacheDir, FOOTWAY_EXTRACT_FILENAME),
  ]);

  const metadata: FootwayExtractMetadata = {
    bounds: FOOTWAY_EXTRACT_BOUNDS,
    regions: [...GEOFABRIK_REGIONS],
    generatedAt: new Date().toISOString(),
  };
  await writeFile(
    join(cacheDir, FOOTWAY_EXTRACT_METADATA_FILENAME),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  console.log(`Wrote ${join(cacheDir, FOOTWAY_EXTRACT_FILENAME)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
