/**
 * Precompute supported walkshed polygons for every OSM stop and
 * write them to public/data/walksheds-<type>-<radius>.json (delta-encoded
 * integers), one file per stop type and radius so the map only downloads the
 * exact dataset it currently needs.
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
  SHIPPED_STOP_RADII_METERS_BY_TYPE,
} from '../src/lib/settings.ts';
import { STOP_TYPES, isStop, isStopType, type Stop, type StopType } from '../src/lib/types.ts';
import { fetchFootwayNetworkInBounds } from '../src/lib/walkshed/overpass.ts';
import { buildWalkGraph, findNearestEdgeSeeds } from '../src/lib/walkshed/graph.ts';
import { buildWalkshedPolygonFromSeeds } from '../src/lib/walkshed/polygon.ts';
import { createWalkshedQueryArea } from '../src/lib/walkshed/query-area.ts';
import {
  WALKSHED_DATA_PRECISION,
  WALKSHED_DATA_VERSION,
  encodeWalkshedPolygon,
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
const DEFAULT_CONCURRENCY = 2;
const MAX_STOPS_PER_BATCH = 48;
const BATCH_LATITUDE_DEGREES = 0.01;
const BATCH_LONGITUDE_DEGREES = 0.015;

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
  encodedByRadius: Map<number, number[]>;
  empty: number; // legitimately empty radius variants (no reachable footways)
}

interface BatchResult {
  resultsByStopKey: Map<string, StopResult>;
  transientFailure: boolean;
}

/** Group stops into small geographic cells. The shared query is padded by the
 * radius bucket and safety margin, preserving the runtime no-truncation invariant. */
function createStopBatches(stops: Stop[]): Stop[][] {
  const stopsByCell = new Map<string, Stop[]>();
  for (const stop of stops) {
    const cellKey = `${Math.floor(stop.lat / BATCH_LATITUDE_DEGREES)}:${Math.floor(stop.lon / BATCH_LONGITUDE_DEGREES)}`;
    const cellStops = stopsByCell.get(cellKey);
    if (cellStops) cellStops.push(stop);
    else stopsByCell.set(cellKey, [stop]);
  }

  const batches: Stop[][] = [];
  for (const cellStops of stopsByCell.values()) {
    for (let start = 0; start < cellStops.length; start += MAX_STOPS_PER_BATCH) {
      batches.push(cellStops.slice(start, start + MAX_STOPS_PER_BATCH));
    }
  }
  return batches;
}

async function computeBatch(stops: Stop[]): Promise<BatchResult> {
  const queryArea = createWalkshedQueryArea(
    stops.map((stop) => ({
      lat: stop.lat,
      lon: stop.lon,
      radiusMeters: Math.max(...SHIPPED_STOP_RADII_METERS_BY_TYPE[stop.type]),
    })),
  );
  if (!queryArea) return { resultsByStopKey: new Map(), transientFailure: false };

  const result = await fetchFootwayNetworkInBounds(queryArea.bounds);
  if (result.status !== 'ok') {
    return { resultsByStopKey: new Map(), transientFailure: true };
  }

  const graph = buildWalkGraph(result.networkData, DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS);
  const resultsByStopKey = new Map<string, StopResult>();
  if (!graph) {
    for (const stop of stops) {
      resultsByStopKey.set(walkshedDatasetPolygonKey(stop), {
        encodedByRadius: new Map(),
        empty: SHIPPED_STOP_RADII_METERS_BY_TYPE[stop.type].length,
      });
    }
    return { resultsByStopKey, transientFailure: false };
  }

  for (const stop of stops) {
    const radii = SHIPPED_STOP_RADII_METERS_BY_TYPE[stop.type];
    const seeds = findNearestEdgeSeeds(graph, stop.lat, stop.lon);
    const encodedByRadius = new Map<number, number[]>();
    for (const radiusMeters of radii) {
      const polygon = buildWalkshedPolygonFromSeeds(
        graph,
        stop.lat,
        stop.lon,
        radiusMeters,
        seeds,
      ).polygon;
      if (polygon) encodedByRadius.set(radiusMeters, encodeWalkshedPolygon(polygon));
    }
    resultsByStopKey.set(walkshedDatasetPolygonKey(stop), {
      encodedByRadius,
      empty: radii.length - encodedByRadius.size,
    });
  }

  return { resultsByStopKey, transientFailure: false };
}

async function runPass(
  stops: Stop[],
  polygons: Map<string, Record<string, number[]>>,
  concurrency: number,
  report: ProgressReporter,
  passLabel: string,
): Promise<{ empty: number; failed: Stop[] }> {
  const batches = createStopBatches(stops);
  let cursor = 0;
  let done = 0;
  let nextReportAt = 50;
  let empty = 0;
  const failed: Stop[] = [];

  async function worker(): Promise<void> {
    while (cursor < batches.length) {
      const batch = batches[cursor];
      cursor += 1;
      try {
        const { resultsByStopKey, transientFailure } = await computeBatch(batch);
        if (transientFailure) failed.push(...batch);
        else {
          for (const stop of batch) {
            const stopKey = walkshedDatasetPolygonKey(stop);
            const stopResult = resultsByStopKey.get(stopKey);
            if (!stopResult) continue;
            const polygonsByRadius: Record<string, number[]> = {};
            for (const [radiusMeters, encoded] of stopResult.encodedByRadius) {
              if (encoded.length >= 6) polygonsByRadius[String(radiusMeters)] = encoded;
            }
            if (Object.keys(polygonsByRadius).length > 0) {
              polygons.set(stopKey, polygonsByRadius);
            }
            empty += stopResult.empty;
          }
        }
      } catch (error) {
        failed.push(...batch);
        if (failed.length <= batch.length * 3) {
          console.error(`\n  batch starting at ${batch[0]?.id} error:`, String(error));
        }
      }
      done += batch.length;
      if (done >= nextReportAt || done === stops.length) {
        report(
          `  ${passLabel}: ${done}/${stops.length}  ` +
            `(built ${polygons.size} stops, empty ${empty} variants, failed ${failed.length})`,
        );
        while (nextReportAt <= done) nextReportAt += 50;
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
      `radii ${JSON.stringify(SHIPPED_STOP_RADII_METERS_BY_TYPE)})`,
  );

  const polygons = new Map<string, Record<string, number[]>>();
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
  const sortedPolygons: Record<string, Record<string, number[]>> = {};
  for (const id of [...polygons.keys()].sort()) sortedPolygons[id] = polygons.get(id)!;

  await mkdir(outDir, { recursive: true });
  let totalGzipBytes = 0;
  const perTypeSummaries: string[] = [];
  // Only touch the requested types; other types keep their existing files.
  for (const type of types) {
    const polygonKeysOfType = stops
      .filter((stop) => stop.type === type)
      .map(walkshedDatasetPolygonKey)
      .sort();
    for (const radiusMeters of SHIPPED_STOP_RADII_METERS_BY_TYPE[type]) {
      const polygonsForRadius: Record<string, number[]> = {};
      for (const polygonKey of polygonKeysOfType) {
        const encoded = sortedPolygons[polygonKey]?.[String(radiusMeters)];
        if (encoded) polygonsForRadius[polygonKey] = encoded;
      }
      const dataset: WalkshedDataset = {
        version: WALKSHED_DATA_VERSION,
        generatedAt: new Date().toISOString(),
        precision: WALKSHED_DATA_PRECISION,
        allowReasonableStreetCrossings: DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS,
        radiusByType: { ...DEFAULT_STOP_RADIUS_METERS_BY_TYPE, [type]: radiusMeters },
        polygons: polygonsForRadius,
      };
      const filename = shippedWalkshedDataFilename(type, radiusMeters);
      const outPath = join(outDir, filename);
      const json = await writeJsonAtomic(outPath, dataset);
      const gzip = gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).length;
      totalGzipBytes += gzip;
      perTypeSummaries.push(
        `    ${filename}: ${Object.keys(polygonsForRadius).length} polygons (${mib(gzip)} MB gz)`,
      );
    }
  }

  const elapsed = (Date.now() - startedAt) / 1000;
  report(
    `  DONE ${types.join('/')}: built ${polygons.size}, empty ${totalEmpty}, ` +
      `unresolved ${pending.length}, ${mib(totalGzipBytes)} MB gz`,
  );
  console.log(
    `\nWrote ${perTypeSummaries.length} file(s) to ${outDir}\n` +
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
