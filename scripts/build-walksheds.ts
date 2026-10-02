/**
 * Precompute supported walkshed polygons for every OSM stop and
 * write them to public/data/walksheds-<type>-<radius>.json (delta-encoded
 * integers), one file per stop type and radius so the map only downloads the
 * exact dataset it currently needs.
 *
 * Routes on a local OSM extract (`npm run prepare:osm-extract`) rather than
 * Overpass, but reuses the runtime's tag filter, query areas, graph, and
 * polygon modules, so shipped polygons match what the browser would compute
 * from Overpass for the same OSM data. Run periodically alongside
 * `npm run update:stops`.
 *
 *   npm run build:walksheds -- [--types train,tram] [--radius N] [--limit N]
 *                              [--osm-cache-dir path] [--out-dir path]
 *                              [--progress-file path] [--diagnostics-file path]
 *
 * `--types` builds a subset (e.g. train,tram now, bus later); the omitted types
 * keep their existing files. Defaults to all stop types.
 * `--radius` builds one configured radius for exactly one requested stop type.
 *
 * `--progress-file` records timestamped progress history as the build runs.
 * `--diagnostics-file` holds a machine-readable snapshot of the same run. It is
 * rewritten periodically and from the crash/signal handlers, so a build killed
 * by a CI timeout still leaves usable diagnostics behind. GitHub Actions also
 * receives newline-delimited live logs and a step summary.
 *
 * Supporting modules live in scripts/walkshed-build/.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS } from '../src/lib/settings.ts';
import { isStop, type Stop } from '../src/lib/types.ts';
import { walkshedDatasetPolygonKey } from '../src/lib/walkshed/walkshed-codec.ts';
import { computeStopBatch, createStopBatches } from './walkshed-build/batch.ts';
import {
  writeWalkshedDatasets,
  type EncodedPolygonsByPolygonKey,
} from './walkshed-build/datasets.ts';
import {
  createBuildState,
  createDiagnosticsWriter,
  installDiagnosticsHandlers,
  type DiagnosticsWriter,
} from './walkshed-build/diagnostics.ts';
import { formatMebibytes } from './walkshed-build/format.ts';
import { loadLocalFootwayNetwork } from './walkshed-build/local-footway-network.ts';
import { parseBuildOptions } from './walkshed-build/options.ts';
import { createProgressReporter } from './walkshed-build/progress.ts';

const dataDir = join(import.meta.dirname, '..', 'public', 'data');
const stopsPath = join(dataDir, 'osm-stops.json');
/** A polygon needs at least three points, i.e. six delta-encoded integers. */
const MIN_ENCODED_POLYGON_LENGTH = 6;
const PROGRESS_REPORT_STOP_INTERVAL = 250;

async function readStops(): Promise<Stop[]> {
  const payload: unknown = JSON.parse(await readFile(stopsPath, 'utf8'));
  if (!Array.isArray(payload) || !payload.every(isStop)) {
    throw new Error(`${stopsPath} does not contain a valid stop array`);
  }
  return payload;
}

async function main(): Promise<void> {
  const {
    osmCacheDir,
    stopLimit,
    outDir,
    stopTypes,
    radiiByStopType,
    progressFile,
    diagnosticsFile,
  } = parseBuildOptions(process.argv.slice(2), dataDir);
  const requestedStopTypes = new Set(stopTypes);
  const buildableStops = (await readStops()).filter(
    (stop) => stop.isCustom !== true && requestedStopTypes.has(stop.type),
  );
  const stops = Number.isFinite(stopLimit) ? buildableStops.slice(0, stopLimit) : buildableStops;
  const builtRadiiByStopType = Object.fromEntries(
    stopTypes.map((stopType) => [stopType, radiiByStopType[stopType]]),
  );

  console.log(
    `Building walksheds for ${stops.length} ${stopTypes.join('/')} stops ` +
      `(crossings=${DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS}, ` +
      `radii ${JSON.stringify(builtRadiiByStopType)})`,
  );

  const startedAt = Date.now();
  const state = createBuildState(stopTypes, builtRadiiByStopType, stops.length, startedAt);
  const diagnostics = createDiagnosticsWriter(diagnosticsFile, state);
  activeDiagnostics = diagnostics;
  installDiagnosticsHandlers(diagnostics);
  diagnostics.write('running');
  const reportProgress = createProgressReporter(progressFile, startedAt);

  const footwayNetwork = await loadLocalFootwayNetwork(osmCacheDir);
  state.footwayExtract = {
    metadata: footwayNetwork.metadata,
    wayCount: footwayNetwork.wayCount,
    nodeCount: footwayNetwork.nodeCount,
    missingNodeReferenceCount: footwayNetwork.missingNodeReferenceCount,
    loadSeconds: Math.round((Date.now() - startedAt) / 1_000),
  };
  console.log(
    `  loaded OSM extract from ${footwayNetwork.metadata.generatedAt}: ` +
      `${footwayNetwork.wayCount} walkable ways, ${footwayNetwork.nodeCount} nodes ` +
      `(${state.footwayExtract.loadSeconds}s)`,
  );

  const encodedPolygonsByPolygonKey: EncodedPolygonsByPolygonKey = new Map();
  const batches = createStopBatches(stops);
  state.batchCount = batches.length;
  let completedStops = 0;
  let nextProgressReportAtStop = PROGRESS_REPORT_STOP_INTERVAL;

  for (const batch of batches) {
    const polygonResultsByPolygonKey = computeStopBatch(batch, radiiByStopType, footwayNetwork);
    for (const stop of batch) {
      const polygonKey = walkshedDatasetPolygonKey(stop);
      const polygonResult = polygonResultsByPolygonKey.get(polygonKey);
      if (!polygonResult) continue;
      const encodedPolygonsByRadius: Record<string, number[]> = {};
      for (const [radiusMeters, encodedPolygon] of polygonResult.encodedPolygonsByRadiusMeters) {
        if (encodedPolygon.length >= MIN_ENCODED_POLYGON_LENGTH) {
          encodedPolygonsByRadius[String(radiusMeters)] = encodedPolygon;
        }
      }
      if (Object.keys(encodedPolygonsByRadius).length > 0) {
        encodedPolygonsByPolygonKey.set(polygonKey, encodedPolygonsByRadius);
      }
      state.emptyRadiusCount += polygonResult.emptyRadiusCount;
    }

    state.completedBatchCount += 1;
    completedStops += batch.length;
    state.stopsWithPolygonsCount = encodedPolygonsByPolygonKey.size;
    if (completedStops >= nextProgressReportAtStop || completedStops === stops.length) {
      reportProgress(
        `  ${completedStops}/${stops.length} (built ${state.stopsWithPolygonsCount})`,
        `  ${completedStops}/${stops.length} stops  (batches ${state.completedBatchCount}/` +
          `${state.batchCount}, built ${state.stopsWithPolygonsCount} stops, ` +
          `empty ${state.emptyRadiusCount} radius variants)`,
      );
      while (nextProgressReportAtStop <= completedStops) {
        nextProgressReportAtStop += PROGRESS_REPORT_STOP_INTERVAL;
      }
      diagnostics.writeIfDue();
    }
    // Batches run synchronously; yielding lets the SIGTERM handler record
    // diagnostics if CI cancels the job mid-build.
    await yieldToEventLoop();
  }
  process.stdout.write('\n');

  const datasetOutputs = await writeWalkshedDatasets(
    outDir,
    stopTypes,
    radiiByStopType,
    stops,
    encodedPolygonsByPolygonKey,
  );
  state.datasetOutputs.push(...datasetOutputs);

  const totalGzipBytes = datasetOutputs.reduce((total, output) => total + output.gzipBytes, 0);
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(
    `\nWrote ${datasetOutputs.length} file(s) to ${outDir}\n` +
      datasetOutputs
        .map(
          (output) =>
            `    ${output.filename}: ${output.polygonCount} polygons ` +
            `(${formatMebibytes(output.gzipBytes)} MiB gz)`,
        )
        .join('\n') +
      `\n  built ${state.stopsWithPolygonsCount}, empty ${state.emptyRadiusCount} radius variants` +
      `  |  ${elapsedSeconds}s\n` +
      `  total ${formatMebibytes(totalGzipBytes)} MiB gzip`,
  );
  diagnostics.write('completed');
}

/** Set once `main` has built its writer; lets the top-level catch record a
 *  crash that happened after diagnostics became available. */
let activeDiagnostics: DiagnosticsWriter | null = null;

main().catch((error) => {
  activeDiagnostics?.write('crashed', error);
  console.error(error);
  process.exit(1);
});
