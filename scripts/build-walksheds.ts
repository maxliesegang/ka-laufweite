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
 *   npm run build:walksheds -- [--types train,tram] [--radius N] [--limit N]
 *                              [--concurrency N] [--out-dir path] [--progress-file path]
 *                              [--diagnostics-file path]
 *
 * `--types` builds a subset (e.g. train,tram now, bus later); the omitted types
 * keep their existing files. Defaults to all stop types.
 * `--radius` builds one configured radius for exactly one requested stop type.
 * This is primarily useful for parallel CI matrix jobs.
 *
 * `--progress-file` records timestamped progress history as the build runs.
 * `--diagnostics-file` holds a machine-readable snapshot of the same run. It is
 * rewritten periodically, after every pass, and from the crash/signal handlers,
 * so a build killed by a CI timeout still leaves usable diagnostics behind.
 * GitHub Actions also receives newline-delimited live logs and a step summary.
 *
 * Supporting modules live in scripts/walkshed-build/.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  trackOverpassMetrics,
  type BuildState,
  type DiagnosticsWriter,
} from './walkshed-build/diagnostics.ts';
import { averageMs, formatMebibytes, formatSeconds } from './walkshed-build/format.ts';
import { parseBuildOptions, type RadiiMetersByStopType } from './walkshed-build/options.ts';
import { createProgressReporter, type ProgressReporter } from './walkshed-build/progress.ts';

const dataDir = join(import.meta.dirname, '..', 'public', 'data');
const stopsPath = join(dataDir, 'osm-stops.json');
const RETRY_PASSES = 2;
const RETRY_DELAY_MS = 3_000;
/** A polygon needs at least three points, i.e. six delta-encoded integers. */
const MIN_ENCODED_POLYGON_LENGTH = 6;
const PROGRESS_REPORT_STOP_INTERVAL = 50;

/** Everything a pass shares with the run around it. Passes differ only in which
 *  stops they process, so the rest is threaded through unchanged. */
interface PassContext {
  encodedPolygonsByPolygonKey: EncodedPolygonsByPolygonKey;
  radiiByStopType: RadiiMetersByStopType;
  concurrency: number;
  reportProgress: ProgressReporter;
  state: BuildState;
  diagnostics: DiagnosticsWriter;
}

/** Build every batch of `stops`, returning the stops that failed transiently
 *  and are worth retrying in a later pass. */
async function runPass(stops: Stop[], passLabel: string, context: PassContext): Promise<Stop[]> {
  const { encodedPolygonsByPolygonKey, radiiByStopType, state, diagnostics } = context;
  const batches = createStopBatches(stops);
  state.batchCount += batches.length;
  let nextBatchIndex = 0;
  let completedStops = 0;
  let completedBatches = 0;
  let nextProgressReportAtStop = PROGRESS_REPORT_STOP_INTERVAL;
  const failedStops: Stop[] = [];

  async function worker(): Promise<void> {
    while (nextBatchIndex < batches.length) {
      const batch = batches[nextBatchIndex];
      nextBatchIndex += 1;
      try {
        const { polygonResultsByPolygonKey, transientFailure, fetchDurationMs } =
          await computeStopBatch(batch, radiiByStopType);
        if (fetchDurationMs !== null) {
          const { overpass } = state;
          overpass.batchFetches += 1;
          overpass.totalBatchFetchMs += fetchDurationMs;
          overpass.maxBatchFetchMs = Math.max(overpass.maxBatchFetchMs, fetchDurationMs);
        }

        if (transientFailure) failedStops.push(...batch);
        else {
          for (const stop of batch) {
            const polygonKey = walkshedDatasetPolygonKey(stop);
            const polygonResult = polygonResultsByPolygonKey.get(polygonKey);
            if (!polygonResult) continue;
            const encodedPolygonsByRadius: Record<string, number[]> = {};
            for (const [
              radiusMeters,
              encodedPolygon,
            ] of polygonResult.encodedPolygonsByRadiusMeters) {
              if (encodedPolygon.length >= MIN_ENCODED_POLYGON_LENGTH) {
                encodedPolygonsByRadius[String(radiusMeters)] = encodedPolygon;
              }
            }
            if (Object.keys(encodedPolygonsByRadius).length > 0) {
              encodedPolygonsByPolygonKey.set(polygonKey, encodedPolygonsByRadius);
            }
            state.emptyRadiusCount += polygonResult.emptyRadiusCount;
          }
        }
      } catch (error) {
        failedStops.push(...batch);
        if (failedStops.length <= batch.length * 3) {
          console.error(`\n  batch starting at ${batch[0]?.id} error:`, String(error));
        }
      }

      completedBatches += 1;
      completedStops += batch.length;
      state.stopsWithPolygonsCount = encodedPolygonsByPolygonKey.size;
      if (completedStops >= nextProgressReportAtStop || completedStops === stops.length) {
        reportPassProgress(context, passLabel, {
          completedStops,
          totalStops: stops.length,
          completedBatches,
          totalBatches: batches.length,
          failedStopCount: failedStops.length,
        });
        while (nextProgressReportAtStop <= completedStops) {
          nextProgressReportAtStop += PROGRESS_REPORT_STOP_INTERVAL;
        }
        diagnostics.writeIfDue();
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, context.concurrency) }, () => worker()));
  process.stdout.write('\n');
  state.stopsWithPolygonsCount = encodedPolygonsByPolygonKey.size;
  state.passesCompleted += 1;
  state.unresolvedStops = failedStops;
  diagnostics.write('running');
  return failedStops;
}

interface PassProgress {
  completedStops: number;
  totalStops: number;
  completedBatches: number;
  totalBatches: number;
  failedStopCount: number;
}

function reportPassProgress(
  { reportProgress, state, encodedPolygonsByPolygonKey }: PassContext,
  passLabel: string,
  { completedStops, totalStops, completedBatches, totalBatches, failedStopCount }: PassProgress,
): void {
  const { overpass } = state;
  const builtStopCount = encodedPolygonsByPolygonKey.size;
  reportProgress(
    `  ${passLabel}: ${completedStops}/${totalStops} ` +
      `(built ${builtStopCount}, failed ${failedStopCount})`,
    `  ${passLabel}: ${completedStops}/${totalStops}  ` +
      `(batches ${completedBatches}/${totalBatches}, built ${builtStopCount} stops, ` +
      `empty ${state.emptyRadiusCount} radius variants, failed ${failedStopCount}, ` +
      `http ${overpass.httpAttempts} attempts / ${overpass.httpFailures} failed, ` +
      `http avg ${formatSeconds(averageMs(overpass.totalHttpMs, overpass.httpAttempts))} ` +
      `max ${formatSeconds(overpass.maxHttpMs)}, ` +
      `backoff ${formatSeconds(overpass.totalBackoffMs)})`,
  );
}

async function readStops(): Promise<Stop[]> {
  const payload: unknown = JSON.parse(await readFile(stopsPath, 'utf8'));
  if (!Array.isArray(payload) || !payload.every(isStop)) {
    throw new Error(`${stopsPath} does not contain a valid stop array`);
  }
  return payload;
}

async function main(): Promise<void> {
  const {
    concurrency,
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
      `(concurrency ${concurrency}, crossings=${DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS}, ` +
      `radii ${JSON.stringify(builtRadiiByStopType)})`,
  );

  const startedAt = Date.now();
  const state = createBuildState(stopTypes, builtRadiiByStopType, stops.length, startedAt);
  const diagnostics = createDiagnosticsWriter(diagnosticsFile, state);
  activeDiagnostics = diagnostics;
  installDiagnosticsHandlers(diagnostics);
  trackOverpassMetrics(state);
  diagnostics.write('running');

  const context: PassContext = {
    encodedPolygonsByPolygonKey: new Map(),
    radiiByStopType,
    concurrency,
    reportProgress: createProgressReporter(progressFile, startedAt),
    state,
    diagnostics,
  };

  let unresolvedStops = stops;
  for (let pass = 0; pass <= RETRY_PASSES && unresolvedStops.length > 0; pass += 1) {
    if (pass > 0) console.log(`  retry pass ${pass}: ${unresolvedStops.length} stop(s)`);
    unresolvedStops = await runPass(
      unresolvedStops,
      pass === 0 ? 'pass 1' : `retry ${pass}`,
      context,
    );
    if (unresolvedStops.length > 0 && pass < RETRY_PASSES) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (pass + 1)));
    }
  }

  const datasetOutputs = await writeWalkshedDatasets(
    outDir,
    stopTypes,
    radiiByStopType,
    stops,
    context.encodedPolygonsByPolygonKey,
  );
  state.datasetOutputs.push(...datasetOutputs);
  state.unresolvedStops = unresolvedStops;

  const builtStopCount = context.encodedPolygonsByPolygonKey.size;
  const totalGzipBytes = datasetOutputs.reduce((total, output) => total + output.gzipBytes, 0);
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(0);
  context.reportProgress(
    `  DONE ${stopTypes.join('/')}: built ${builtStopCount}, empty ${state.emptyRadiusCount}, ` +
      `unresolved ${unresolvedStops.length}, ${formatMebibytes(totalGzipBytes)} MiB gz`,
  );
  console.log(
    `\nWrote ${datasetOutputs.length} file(s) to ${outDir}\n` +
      datasetOutputs
        .map(
          (output) =>
            `    ${output.filename}: ${output.polygonCount} polygons ` +
            `(${formatMebibytes(output.gzipBytes)} MiB gz)`,
        )
        .join('\n') +
      `\n  built ${builtStopCount}, empty ${state.emptyRadiusCount} radius variants, ` +
      `unresolved ${unresolvedStops.length}  |  ${elapsedSeconds}s\n` +
      `  total ${formatMebibytes(totalGzipBytes)} MiB gzip`,
  );

  diagnostics.write(unresolvedStops.length > 0 ? 'unresolved-stops' : 'completed');
  if (unresolvedStops.length > 0) {
    console.warn(
      `  WARNING: ${unresolvedStops.length} stop(s) unresolved after retries (Overpass throttling).`,
    );
    process.exitCode = 1;
  }
}

/** Set once `main` has built its writer; lets the top-level catch record a
 *  crash that happened after diagnostics became available. */
let activeDiagnostics: DiagnosticsWriter | null = null;

main().catch((error) => {
  activeDiagnostics?.write('crashed', error);
  console.error(error);
  process.exit(1);
});
