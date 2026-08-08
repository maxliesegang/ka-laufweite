/** Print one GitHub Actions matrix shard per stop type. Each shard builds all
 * configured radii together so they reuse the same Overpass network graph. */
import { SHIPPED_STOP_RADII_METERS_BY_TYPE } from '../src/lib/settings.ts';
import { STOP_TYPES } from '../src/lib/types.ts';

const include = STOP_TYPES.filter((type) => SHIPPED_STOP_RADII_METERS_BY_TYPE[type].length > 0).map(
  (type) => ({ type }),
);

process.stdout.write(JSON.stringify({ include }));
