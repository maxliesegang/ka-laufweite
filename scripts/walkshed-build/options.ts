/** Command-line options for `scripts/build-walksheds.ts`. */
import { SHIPPED_STOP_RADII_METERS_BY_TYPE } from '../../src/lib/settings.ts';
import { STOP_TYPES, isStopType, type StopType } from '../../src/lib/types.ts';

/** Radii to build per stop type, in meters. */
export type RadiiMetersByStopType = Record<StopType, readonly number[]>;

export interface BuildOptions {
  concurrency: number;
  stopLimit: number;
  outDir: string;
  /** Stop types to build; other types keep their existing files untouched. */
  stopTypes: StopType[];
  /** Effective radii to build per type. `--radius` narrows the single requested
   *  type to one value; every other type keeps its full shipped set. */
  radiiByStopType: RadiiMetersByStopType;
  /** Timestamped progress history, retained for failed CI builds. */
  progressFile: string | null;
  /** Machine-readable build metrics and unresolved stops for CI diagnostics. */
  diagnosticsFile: string | null;
}

export const DEFAULT_CONCURRENCY = 2;

function parseNonNegativeInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${option} must be a non-negative integer, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseStopTypes(value: string): StopType[] {
  const requestedTypes = value.split(',').map((part) => part.trim());
  const unknownTypes = requestedTypes.filter((part) => !isStopType(part));
  if (unknownTypes.length > 0) {
    throw new Error(`--types has unknown stop type(s): ${unknownTypes.join(', ')}`);
  }
  // De-duplicate while preserving canonical STOP_TYPES order for stable output.
  return STOP_TYPES.filter((stopType) => requestedTypes.includes(stopType));
}

/** Derive the per-type radii to build. Without `--radius` every requested type
 *  builds its full shipped set; with it, the single requested type is narrowed
 *  to that one value (other types are irrelevant — only `stopTypes` is written). */
function resolveRadiiByType(
  stopTypes: StopType[],
  radiusMeters: number | null,
): RadiiMetersByStopType {
  const radiiByStopType: RadiiMetersByStopType = { ...SHIPPED_STOP_RADII_METERS_BY_TYPE };
  if (radiusMeters === null) return radiiByStopType;

  if (stopTypes.length !== 1) {
    throw new Error('--radius requires exactly one stop type via --types');
  }
  const [stopType] = stopTypes;
  if (!SHIPPED_STOP_RADII_METERS_BY_TYPE[stopType].includes(radiusMeters)) {
    throw new Error(
      `--radius ${radiusMeters} is not configured for ${stopType}; expected one of ` +
        SHIPPED_STOP_RADII_METERS_BY_TYPE[stopType].join(', '),
    );
  }
  radiiByStopType[stopType] = [radiusMeters];
  return radiiByStopType;
}

export function parseBuildOptions(args: string[], defaultOutDir: string): BuildOptions {
  let concurrency = DEFAULT_CONCURRENCY;
  let stopLimit = Number.POSITIVE_INFINITY;
  let outDir = defaultOutDir;
  let stopTypes: StopType[] = [...STOP_TYPES];
  let radiusMeters: number | null = null;
  let progressFile: string | null = null;
  let diagnosticsFile: string | null = null;

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`Expected --option value, received ${JSON.stringify(option)}`);
    }

    if (option === '--concurrency') {
      concurrency = parseNonNegativeInteger(value, option);
      if (concurrency === 0) throw new Error('--concurrency must be greater than zero');
    } else if (option === '--limit') {
      stopLimit = parseNonNegativeInteger(value, option);
    } else if (option === '--out-dir') {
      outDir = value;
    } else if (option === '--types') {
      stopTypes = parseStopTypes(value);
      if (stopTypes.length === 0) throw new Error('--types must name at least one stop type');
    } else if (option === '--radius') {
      radiusMeters = parseNonNegativeInteger(value, option);
      if (radiusMeters === 0) throw new Error('--radius must be greater than zero');
    } else if (option === '--progress-file') {
      progressFile = value;
    } else if (option === '--diagnostics-file') {
      diagnosticsFile = value;
    } else {
      throw new Error(`Unknown option ${option}`);
    }
  }

  return {
    concurrency,
    stopLimit,
    outDir,
    stopTypes,
    radiiByStopType: resolveRadiiByType(stopTypes, radiusMeters),
    progressFile,
    diagnosticsFile,
  };
}
