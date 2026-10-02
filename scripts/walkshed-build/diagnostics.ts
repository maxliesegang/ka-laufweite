/**
 * Build metrics and their two renderings: a machine-readable JSON snapshot and
 * the GitHub Actions step summary. The snapshot is rewritten periodically and
 * from the crash/signal handlers, so a build killed by a CI timeout still
 * leaves usable diagnostics behind.
 */
import { appendFileSync, writeFileSync } from 'node:fs';

import type { StopType } from '../../src/lib/types.ts';
import { formatMebibytes } from './format.ts';
import type { FootwayExtractMetadata } from './local-footway-network.ts';

export type BuildStatus = 'running' | 'completed' | 'crashed' | 'interrupted';

/** What the build routed on, so a report shows which OSM snapshot it reflects. */
export interface FootwayExtractSummary {
  metadata: FootwayExtractMetadata;
  wayCount: number;
  nodeCount: number;
  missingNodeReferenceCount: number;
  loadSeconds: number;
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
  batchCount: number;
  completedBatchCount: number;
  footwayExtract: FootwayExtractSummary | null;
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
    batchCount: 0,
    completedBatchCount: 0,
    footwayExtract: null,
    datasetOutputs: [],
    startedAt,
  };
}

/** The single source of truth both the JSON diagnostics file and the GitHub
 *  step summary are rendered from. */
export function createBuildReport(state: BuildState, status: BuildStatus, error?: unknown) {
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
      emptyRadiusVariants: state.emptyRadiusCount,
    },
    batches: { total: state.batchCount, completed: state.completedBatchCount },
    footwayExtract: state.footwayExtract,
    datasetOutputs: state.datasetOutputs,
    totalGzipBytes: state.datasetOutputs.reduce((total, output) => total + output.gzipBytes, 0),
  };
}

export type BuildReport = ReturnType<typeof createBuildReport>;

export function renderStepSummary(report: BuildReport): string {
  const { footwayExtract } = report;
  return (
    `## Walkshed build: ${report.stopTypes.join('/')} (${report.status})\n\n` +
    (report.error ? `> ${report.error}\n\n` : '') +
    `- Radii: \`${JSON.stringify(report.radiiByStopType)}\`\n` +
    `- Stops with polygons: ${report.stops.withPolygons}/${report.stops.total}\n` +
    `- Empty radius variants: ${report.stops.emptyRadiusVariants}\n` +
    `- Batches: ${report.batches.completed}/${report.batches.total}\n` +
    (footwayExtract
      ? `- OSM extract: ${footwayExtract.metadata.regions.join(', ')} ` +
        `(prepared ${footwayExtract.metadata.generatedAt}), ` +
        `${footwayExtract.wayCount} walkable ways, ${footwayExtract.nodeCount} nodes, ` +
        `${footwayExtract.missingNodeReferenceCount} missing node references\n`
      : '') +
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
