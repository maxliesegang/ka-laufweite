/** Print one GitHub Actions matrix shard per stop type. Each shard builds all
 * configured radii together so they reuse the same Overpass network graph.
 * Costly types start first because the matrix has bounded parallelism. */
import { readFileSync } from 'node:fs';

import { SHIPPED_STOP_RADII_METERS_BY_TYPE } from '../src/lib/settings.ts';
import { STOP_TYPES, isStop, type StopType } from '../src/lib/types.ts';

/** Stop counts drive scheduling only. A missing or malformed stop file must not
 *  block every walkshed build over an ordering hint, so fall back to zeroes and
 *  let the canonical `STOP_TYPES` order stand. */
function countStopsByStopType(): Record<StopType, number> {
  const stopCountByStopType = Object.fromEntries(
    STOP_TYPES.map((stopType) => [stopType, 0]),
  ) as Record<StopType, number>;
  try {
    const payload: unknown = JSON.parse(
      readFileSync(new URL('../public/data/osm-stops.json', import.meta.url), 'utf8'),
    );
    if (!Array.isArray(payload) || !payload.every(isStop)) return stopCountByStopType;
    for (const stop of payload) {
      if (stop.isCustom === true) continue;
      stopCountByStopType[stop.type] += 1;
    }
  } catch (error) {
    console.error(`  ordering shards by canonical type order: ${String(error)}`);
  }
  return stopCountByStopType;
}

const stopCountByStopType = countStopsByStopType();

// Array.prototype.sort is stable, so equal counts keep their STOP_TYPES order.
const include = STOP_TYPES.filter(
  (stopType) => SHIPPED_STOP_RADII_METERS_BY_TYPE[stopType].length > 0,
)
  .sort((firstType, secondType) => stopCountByStopType[secondType] - stopCountByStopType[firstType])
  .map((stopType) => ({ type: stopType }));

process.stdout.write(JSON.stringify({ include }));
