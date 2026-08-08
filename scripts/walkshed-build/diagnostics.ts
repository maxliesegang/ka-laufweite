/**
 * Build metrics and their two renderings: a machine-readable JSON snapshot and
 * the GitHub Actions step summary. The snapshot is rewritten periodically,
 * after every pass, and from the crash/signal handlers, so a build killed by a
 * CI timeout still leaves usable diagnostics behind.
 */
import { appendFileSync, writeFileSync } from 'node:fs';

import type { Stop, StopType } from '../../src/lib/types.ts';
import { setOverpassObserver } from '../../src/lib/walkshed/overpass.ts';
import { averageMs, formatMebibytes, formatSeconds } from './format.ts';

export type BuildStatus = 'running' | 'completed' | 'unresolved-stops' | 'crashed' | 'interrupted';

/**
 * Overpass counters. `batchFetches` counts `fetchFootwayNetworkInBounds` calls,
 * whose duration includes the module's internal endpoint fallbacks and backoff
 * sleeps; `httpAttempts` counts individual HTTP requests. Keeping both apart is
 * the difference between "Overpass is slow" and "Overpass is throttling us".
 */
export interface OverpassMetrics {
  batchFetches: number;
  totalBatchFetchMs: number;
  maxBatchFetchMs: number;
  httpAttempts: number;
  httpFailures: number;
  totalHttpMs: number;
  maxHttpMs: number;
  backoffSleeps: number;
  totalBackoffMs: number;
  /** Attempt counts keyed by HTTP status, plus `network` for transport failures. */
  attemptsByOutcome: Record<string, number>;
}

export interface DatasetOutput {
  filename: string;
  polygonCount: number;
  gzipBytes: number;
}

/** Mutable run state. The build updates it in place; the diagnostics writer only reads it. */
export interface BuildState {
  stopTypes: StopType[];
  radiiByStopType: Record<string, readonly number[]>;
  stopCount: number;
  stopsWithPolygonsCount: number;
  emptyRadiusCount: number;
  unresolvedStops: Stop[];
  passesCompleted: number;
  batchCount: number;
  overpass: OverpassMetrics;
  datasetOutputs: DatasetOutput[];
  startedAt: number;
}

export function createBuildState(
  stopTypes: StopType[],
  radiiByStopType: Record<string, readonly number[]>,
  stopCount: number,
  startedAt: number,
): BuildState {
  return {
    stopTypes,
    radiiByStopType,
    stopCount,
    stopsWithPolygonsCount: 0,
    emptyRadiusCount: 0,
    unresolvedStops: [],
    passesCompleted: 0,
    batchCount: 0,
    overpass: {
      batchFetches: 0,
      totalBatchFetchMs: 0,
      maxBatchFetchMs: 0,
      httpAttempts: 0,
      httpFailures: 0,
      totalHttpMs: 0,
      maxHttpMs: 0,
      backoffSleeps: 0,
      totalBackoffMs: 0,
      attemptsByOutcome: {},
    },
    datasetOutputs: [],
    startedAt,
  };
}

/**
 * Record real HTTP attempts, not batch fetches: a single batch fetch can hide
 * several endpoint attempts and backoff sleeps, which is exactly what has to be
 * visible when the build is being throttled.
 */
export function trackOverpassMetrics(state: BuildState): void {
  setOverpassObserver({
    onAttempt(event) {
      const { overpass } = state;
      overpass.httpAttempts += 1;
      overpass.totalHttpMs += event.durationMs;
      overpass.maxHttpMs = Math.max(overpass.maxHttpMs, event.durationMs);
      if (event.outcome !== 'ok') overpass.httpFailures += 1;
      const outcomeKey = event.status === null ? 'network' : String(event.status);
      overpass.attemptsByOutcome[outcomeKey] = (overpass.attemptsByOutcome[outcomeKey] ?? 0) + 1;
    },
    onBackoff(delayMs) {
      state.overpass.backoffSleeps += 1;
      state.overpass.totalBackoffMs += delayMs;
    },
  });
}

/** The single source of truth both the JSON diagnostics file and the GitHub
 *  step summary are rendered from. */
export function createBuildReport(state: BuildState, status: BuildStatus, error?: unknown) {
  const { overpass } = state;
  return {
    status,
    generatedAt: new Date().toISOString(),
    elapsedSeconds: Math.round((Date.now() - state.startedAt) / 1_000),
    error: error === undefined ? undefined : String(error),
    stopTypes: state.stopTypes,
    radiiByStopType: state.radiiByStopType,
    stops: {
      total: state.stopCount,
      withPolygons: state.stopsWithPolygonsCount,
      unresolved: state.unresolvedStops.length,
      emptyRadiusVariants: state.emptyRadiusCount,
    },
    passesCompleted: state.passesCompleted,
    retryPasses: Math.max(0, state.passesCompleted - 1),
    batchCount: state.batchCount,
    overpass: {
      batchFetches: overpass.batchFetches,
      averageBatchFetchMs: averageMs(overpass.totalBatchFetchMs, overpass.batchFetches),
      maxBatchFetchMs: overpass.maxBatchFetchMs,
      httpAttempts: overpass.httpAttempts,
      httpFailures: overpass.httpFailures,
      averageHttpMs: averageMs(overpass.totalHttpMs, overpass.httpAttempts),
      maxHttpMs: overpass.maxHttpMs,
      backoffSleeps: overpass.backoffSleeps,
      totalBackoffMs: Math.round(overpass.totalBackoffMs),
      attemptsByOutcome: overpass.attemptsByOutcome,
    },
    datasetOutputs: state.datasetOutputs,
    totalGzipBytes: state.datasetOutputs.reduce((total, output) => total + output.gzipBytes, 0),
    unresolvedStops: state.unresolvedStops.map((stop) => ({
      id: stop.id,
      type: stop.type,
      lat: stop.lat,
      lon: stop.lon,
    })),
  };
}

export type BuildReport = ReturnType<typeof createBuildReport>;

export function renderStepSummary(report: BuildReport): string {
  const { overpass } = report;
  const outcomes = Object.entries(overpass.attemptsByOutcome)
    .map(([outcome, count]) => `${outcome}×${count}`)
    .join(', ');
  return (
    `## Walkshed build: ${report.stopTypes.join('/')} (${report.status})\n\n` +
    (report.error ? `> ${report.error}\n\n` : '') +
    `- Radii: \`${JSON.stringify(report.radiiByStopType)}\`\n` +
    `- Stops with polygons: ${report.stops.withPolygons}/${report.stops.total}\n` +
    `- Empty radius variants: ${report.stops.emptyRadiusVariants}\n` +
    `- Unresolved stops: ${report.stops.unresolved}\n` +
    `- Passes: ${report.passesCompleted} (${report.retryPasses} retries)\n` +
    `- Batch fetches: ${overpass.batchFetches} across ${report.batchCount} batches, ` +
    `${formatSeconds(overpass.averageBatchFetchMs)} average, ${formatSeconds(overpass.maxBatchFetchMs)} maximum ` +
    `(includes endpoint fallbacks and backoff)\n` +
    `- HTTP attempts: ${overpass.httpAttempts} (${overpass.httpFailures} failed), ` +
    `${formatSeconds(overpass.averageHttpMs)} average, ${formatSeconds(overpass.maxHttpMs)} maximum` +
    (outcomes ? ` — ${outcomes}` : '') +
    `\n` +
    `- Backoff sleeps: ${overpass.backoffSleeps}, ${formatSeconds(overpass.totalBackoffMs)} total\n` +
    `- Output: ${report.datasetOutputs.length} files, ${formatMebibytes(report.totalGzipBytes)} MiB gzip\n` +
    `- Elapsed: ${report.elapsedSeconds} seconds\n\n`
  );
}

function appendGitHubStepSummary(markdown: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    appendFileSync(summaryPath, markdown);
  } catch {
    // Best-effort: summary output must never fail a completed dataset build.
  }
}

const DIAGNOSTICS_WRITE_INTERVAL_MS = 30_000;

export interface DiagnosticsWriter {
  write: (status: BuildStatus, error?: unknown) => void;
  /** Periodic checkpoint so a hard kill still leaves recent numbers behind. */
  writeIfDue: () => void;
}

/**
 * Writes the diagnostics snapshot. Everything here is synchronous and
 * best-effort so it can also run from a signal handler, where the event loop
 * gets no further turns.
 */
export function createDiagnosticsWriter(
  diagnosticsFile: string | null,
  state: BuildState,
): DiagnosticsWriter {
  let lastWriteAt = 0;
  let summaryWritten = false;

  const write = (status: BuildStatus, error?: unknown): void => {
    lastWriteAt = Date.now();
    const report = createBuildReport(state, status, error);
    if (diagnosticsFile) {
      try {
        writeFileSync(diagnosticsFile, `${JSON.stringify(report, null, 2)}\n`);
      } catch {
        /* ignore */
      }
    }
    // The step summary is a final verdict, so emit it once per run only.
    if (status !== 'running' && !summaryWritten) {
      summaryWritten = true;
      appendGitHubStepSummary(renderStepSummary(report));
    }
  };

  return {
    write,
    writeIfDue: (): void => {
      if (Date.now() - lastWriteAt >= DIAGNOSTICS_WRITE_INTERVAL_MS) write('running');
    },
  };
}

/**
 * Diagnostics have to survive the failures that matter most — an uncaught throw
 * and the SIGTERM/SIGINT a CI runner sends when it cancels or times a job out —
 * because those are exactly the runs nobody can reproduce locally.
 */
export function installDiagnosticsHandlers(diagnostics: DiagnosticsWriter): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      diagnostics.write('interrupted', `received ${signal}`);
      process.exit(1);
    });
  }
  process.once('uncaughtException', (error) => {
    diagnostics.write('crashed', error);
    console.error(error);
    process.exit(1);
  });
  process.once('unhandledRejection', (reason) => {
    diagnostics.write('crashed', reason);
    console.error(reason);
    process.exit(1);
  });
}
