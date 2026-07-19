/**
 * Precompute default-configuration walkshed polygons for every OSM stop and
 * write them to public/data/walksheds-<type>.json (delta-encoded integers), one
 * file per stop type so the map only downloads the types it currently shows.
 *
 * Reuses the exact runtime modules, so shipped polygons are identical to what
 * the browser would have computed from Overpass. Run periodically alongside
 * `npm run update:stops`.
 *
 *   npm run build:walksheds -- [--types train,tram] [--limit N] [--concurrency N]
 *                              [--out-dir path] [--progress-file path]
 *
 * `--types` builds a subset (e.g. train,tram now, bus later); the omitted types
 * keep their existing files. Defaults to all stop types.
 *
 * `--progress-file` overwrites the given file with the latest progress line as the
 * build runs — readable even when stdout is buffered by a pipe (e.g. CI logs).
 */
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS,
  DEFAULT_STOP_RADIUS_METERS_BY_TYPE,
} from '../src/lib/settings.ts';
import { STOP_TYPES, isStop, isStopType, type Stop, type StopType } from '../src/lib/types.ts';
import { fetchFootways } from '../src/lib/walkshed/overpass.ts';
import { buildWalkGraph, nearestEdgeSeeds } from '../src/lib/walkshed/graph.ts';
import { buildPolygonFromSeedNodes } from '../src/lib/walkshed/polygon.ts';
import {
  WALKSHED_DATA_PRECISION,
  WALKSHED_DATA_VERSION,
  encodeWalkshedPolygon,
  partitionWalkshedDatasetByType,
  shippedWalkshedDataFilename,
  walkshedDatasetPolygonKey,
  type WalkshedDataset,
} from '../src/lib/walkshed/walkshed-codec.ts';

interface BuildOptions {
  concurrency: number;
  limit: number;
  outDir: string;
  /** Stop types to build; other types keep their existing files untouched. */
  types: StopType[];
  /** File to overwrite with the latest progress line; readable while the build
   *  runs even when stdout is buffered by a pipe. */
  progressFile: string | null;
}

/** Emits a progress line to stdout and, if configured, to a file synchronously. */
type ProgressReporter = (line: string) => void;

function createProgressReporter(progressFile: string | null, startedAt: number): ProgressReporter {
  return (line: string) => {
    process.stdout.write(`${line}\r`);
    if (!progressFile) return;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    // Best-effort: never fail the build because progress couldn't be written.
    try {
      writeFileSync(progressFile, `${line}  |  ${elapsed}s elapsed\n`);
    } catch {
      /* ignore */
    }
  };
}

const dataDir = join(import.meta.dirname, '..', 'public', 'data');
const stopsPath = join(dataDir, 'osm-stops.json');
const RETRY_PASSES = 2;
const DEFAULT_CONCURRENCY = 6;

function mib(bytes: number): string {
  return (bytes / 1_048_576).toFixed(2);
}

/** Write JSON to a temp file and rename into place so readers never see a
 *  half-written dataset. Returns the serialized JSON for size reporting. */
async function writeJsonAtomic(outPath: string, data: unknown): Promise<string> {
  const json = JSON.stringify(data);
  const temporaryOutPath = `${outPath}.tmp`;
  await writeFile(temporaryOutPath, json);
  await rename(temporaryOutPath, outPath);
  return json;
}

function parseNonNegativeInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${option} must be a non-negative integer, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseTypes(value: string): StopType[] {
  const requested = value.split(',').map((part) => part.trim());
  const invalid = requested.filter((part) => !isStopType(part));
  if (invalid.length > 0) {
    throw new Error(`--types has unknown stop type(s): ${invalid.join(', ')}`);
  }
  // De-duplicate while preserving canonical STOP_TYPES order for stable output.
  return STOP_TYPES.filter((type) => requested.includes(type));
}

function parseOptions(args: string[]): BuildOptions {
  const options: BuildOptions = {
    concurrency: DEFAULT_CONCURRENCY,
    limit: Number.POSITIVE_INFINITY,
    outDir: dataDir,
    types: [...STOP_TYPES],
    progressFile: null,
  };

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`Expected --option value, received ${JSON.stringify(option)}`);
    }

    if (option === '--concurrency') {
      options.concurrency = parseNonNegativeInteger(value, option);
      if (options.concurrency === 0) throw new Error('--concurrency must be greater than zero');
    } else if (option === '--limit') {
      options.limit = parseNonNegativeInteger(value, option);
    } else if (option === '--out-dir') {
      options.outDir = value;
    } else if (option === '--types') {
      options.types = parseTypes(value);
      if (options.types.length === 0) throw new Error('--types must name at least one stop type');
    } else if (option === '--progress-file') {
      options.progressFile = value;
    } else {
      throw new Error(`Unknown option ${option}`);
    }
  }

  return options;
}

interface StopResult {
  encoded: number[] | null; // null = legitimately empty (no reachable footways)
  transientFailure: boolean; // Overpass unreachable/throttled — worth retrying
}

async function computeStop(stop: Stop): Promise<StopResult> {
  const radius = DEFAULT_STOP_RADIUS_METERS_BY_TYPE[stop.type];
  const result = await fetchFootways(stop.lat, stop.lon, radius);
  if (result.status !== 'ok') return { encoded: null, transientFailure: true };

  const graph = buildWalkGraph(result.response, DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS);
  if (!graph) return { encoded: null, transientFailure: false };

  const seeds = nearestEdgeSeeds(graph, stop.lat, stop.lon);
  const polygon = buildPolygonFromSeedNodes(graph, stop.lat, stop.lon, radius, seeds).polygon;
  if (!polygon) return { encoded: null, transientFailure: false };

  return { encoded: encodeWalkshedPolygon(polygon), transientFailure: false };
}

async function runPass(
  stops: Stop[],
  polygons: Map<string, number[]>,
  concurrency: number,
  report: ProgressReporter,
  passLabel: string,
): Promise<{ empty: number; failed: Stop[] }> {
  let cursor = 0;
  let done = 0;
  let empty = 0;
  const failed: Stop[] = [];

  async function worker(): Promise<void> {
    while (cursor < stops.length) {
      const stop = stops[cursor];
      cursor += 1;
      try {
        const { encoded, transientFailure } = await computeStop(stop);
        if (transientFailure) failed.push(stop);
        else if (encoded && encoded.length >= 6) {
          polygons.set(walkshedDatasetPolygonKey(stop), encoded);
        } else empty += 1;
      } catch (error) {
        failed.push(stop);
        if (failed.length <= 3) console.error(`\n  ${stop.id} error:`, String(error));
      }
      done += 1;
      if (done % 50 === 0 || done === stops.length) {
        report(
          `  ${passLabel}: ${done}/${stops.length}  ` +
            `(built ${polygons.size}, empty ${empty}, failed ${failed.length})`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  process.stdout.write('\n');
  return { empty, failed };
}

async function main(): Promise<void> {
  const { concurrency, limit, outDir, types, progressFile } = parseOptions(process.argv.slice(2));
  const payload: unknown = JSON.parse(await readFile(stopsPath, 'utf8'));
  if (!Array.isArray(payload) || !payload.every(isStop)) {
    throw new Error(`${stopsPath} does not contain a valid stop array`);
  }
  const buildTypes = new Set(types);
  const allStops = payload.filter((stop) => stop.isCustom !== true && buildTypes.has(stop.type));
  const stops = Number.isFinite(limit) ? allStops.slice(0, limit) : allStops;

  console.log(
    `Building walksheds for ${stops.length} ${types.join('/')} stops ` +
      `(concurrency ${concurrency}, crossings=${DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS}, ` +
      `radii ${JSON.stringify(DEFAULT_STOP_RADIUS_METERS_BY_TYPE)})`,
  );

  const polygons = new Map<string, number[]>();
  const startedAt = Date.now();
  const report = createProgressReporter(progressFile, startedAt);

  let pending = stops;
  let totalEmpty = 0;
  for (let pass = 0; pass <= RETRY_PASSES && pending.length > 0; pass += 1) {
    if (pass > 0) console.log(`  retry pass ${pass}: ${pending.length} stop(s)`);
    const passLabel = pass === 0 ? 'pass 1' : `retry ${pass}`;
    const { empty, failed } = await runPass(pending, polygons, concurrency, report, passLabel);
    totalEmpty += empty;
    pending = failed;
    if (failed.length > 0 && pass < RETRY_PASSES) {
      await new Promise((resolve) => setTimeout(resolve, 3_000 * (pass + 1)));
    }
  }

  // Sort stop keys for deterministic output and compression-friendly shared prefixes.
  const sortedPolygons: Record<string, number[]> = {};
  for (const id of [...polygons.keys()].sort()) sortedPolygons[id] = polygons.get(id)!;

  const dataset: WalkshedDataset = {
    version: WALKSHED_DATA_VERSION,
    generatedAt: new Date().toISOString(),
    precision: WALKSHED_DATA_PRECISION,
    allowReasonableStreetCrossings: DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS,
    radiusByType: DEFAULT_STOP_RADIUS_METERS_BY_TYPE,
    polygons: sortedPolygons,
  };

  await mkdir(outDir, { recursive: true });
  const datasetByType = partitionWalkshedDatasetByType(dataset);
  let totalGzipBytes = 0;
  const perTypeSummaries: string[] = [];
  // Only touch the requested types; other types keep their existing files.
  for (const type of types) {
    const outPath = join(outDir, shippedWalkshedDataFilename(type));
    const json = await writeJsonAtomic(outPath, datasetByType[type]);
    const gzip = gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).length;
    totalGzipBytes += gzip;
    const count = Object.keys(datasetByType[type].polygons).length;
    perTypeSummaries.push(
      `    ${shippedWalkshedDataFilename(type)}: ${count} (${mib(gzip)} MB gz)`,
    );
  }

  const elapsed = (Date.now() - startedAt) / 1000;
  report(
    `  DONE ${types.join('/')}: built ${polygons.size}, empty ${totalEmpty}, ` +
      `unresolved ${pending.length}, ${mib(totalGzipBytes)} MB gz`,
  );
  console.log(
    `\nWrote ${types.length} file(s) to ${outDir}\n` +
      perTypeSummaries.join('\n') +
      `\n  built ${polygons.size}, empty ${totalEmpty}, unresolved ${pending.length}  |  ${elapsed.toFixed(0)}s\n` +
      `  total ${mib(totalGzipBytes)} MB gzip`,
  );
  if (pending.length > 0) {
    console.warn(
      `  WARNING: ${pending.length} stop(s) unresolved after retries (Overpass throttling).`,
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
