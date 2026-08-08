/** Serialization of the built polygons into the shipped per-type, per-radius files. */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS,
  DEFAULT_STOP_RADIUS_METERS_BY_TYPE,
} from '../../src/lib/settings.ts';
import type { Stop, StopType } from '../../src/lib/types.ts';
import {
  WALKSHED_DATA_PRECISION,
  WALKSHED_DATA_VERSION,
  shippedWalkshedDataFilename,
  walkshedDatasetPolygonKey,
  type WalkshedDataset,
} from '../../src/lib/walkshed/walkshed-codec.ts';
import type { RadiiMetersByStopType } from './options.ts';
import type { DatasetOutput } from './diagnostics.ts';

/**
 * Every built polygon, keyed by dataset polygon key (`id:type:lat:lon`) and then
 * by radius in meters — the two levels the shipped files are partitioned along.
 */
export type EncodedPolygonsByPolygonKey = Map<string, Record<string, number[]>>;

/** Write JSON to a temp file and rename into place so readers never see a
 *  half-written dataset. Returns the serialized JSON for size reporting. */
async function writeJsonAtomic(outPath: string, dataset: unknown): Promise<string> {
  const json = JSON.stringify(dataset);
  const temporaryOutPath = `${outPath}.tmp`;
  await writeFile(temporaryOutPath, json);
  await rename(temporaryOutPath, outPath);
  return json;
}

/** Write one file per requested type and radius. Types that were not built keep
 *  their existing files, so a partial build never drops shipped data. */
export async function writeWalkshedDatasets(
  outDir: string,
  stopTypes: StopType[],
  radiiByStopType: RadiiMetersByStopType,
  stops: Stop[],
  encodedPolygonsByPolygonKey: EncodedPolygonsByPolygonKey,
): Promise<DatasetOutput[]> {
  await mkdir(outDir, { recursive: true });
  const generatedAt = new Date().toISOString();
  const datasetOutputs: DatasetOutput[] = [];

  for (const stopType of stopTypes) {
    // Sorted for deterministic output and compression-friendly shared prefixes.
    const polygonKeysOfType = stops
      .filter((stop) => stop.type === stopType)
      .map(walkshedDatasetPolygonKey)
      .sort();

    for (const radiusMeters of radiiByStopType[stopType]) {
      const polygonsForRadius: Record<string, number[]> = {};
      for (const polygonKey of polygonKeysOfType) {
        const encodedPolygon = encodedPolygonsByPolygonKey.get(polygonKey)?.[String(radiusMeters)];
        if (encodedPolygon) polygonsForRadius[polygonKey] = encodedPolygon;
      }

      const dataset: WalkshedDataset = {
        version: WALKSHED_DATA_VERSION,
        generatedAt,
        precision: WALKSHED_DATA_PRECISION,
        allowReasonableStreetCrossings: DEFAULT_ALLOW_REASONABLE_STREET_CROSSINGS,
        radiusByType: { ...DEFAULT_STOP_RADIUS_METERS_BY_TYPE, [stopType]: radiusMeters },
        polygons: polygonsForRadius,
      };
      const filename = shippedWalkshedDataFilename(stopType, radiusMeters);
      const json = await writeJsonAtomic(join(outDir, filename), dataset);

      datasetOutputs.push({
        filename,
        polygonCount: Object.keys(polygonsForRadius).length,
        gzipBytes: gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).length,
      });
    }
  }

  return datasetOutputs;
}
