/** Print the GitHub Actions matrix for every shipped stop-type/radius pair. */
import { SHIPPED_STOP_RADII_METERS_BY_TYPE } from '../src/lib/settings.ts';
import { STOP_TYPES } from '../src/lib/types.ts';

const include = STOP_TYPES.flatMap((type) =>
  SHIPPED_STOP_RADII_METERS_BY_TYPE[type].map((radius) => ({ type, radius })),
);

process.stdout.write(JSON.stringify({ include }));
