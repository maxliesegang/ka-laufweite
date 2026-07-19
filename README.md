# KA Laufweite

Interactive map showing walkable coverage around tram, train, and bus stops in the KVV network (Karlsruhe region). Instead of simple radius circles, it calculates real walking distances along OpenStreetMap footpaths — so you see what you can actually reach on foot.

Live site: [maxliesegang.github.io/ka-laufweite](https://maxliesegang.github.io/ka-laufweite/)

## Features

- **Walkshed polygons** — coverage areas based on real walkable paths from OSM, computed via Dijkstra's algorithm and concave hull generation in a Web Worker when available
- **Batched network loading** — nearby stops share bounded Overpass queries and cached walk graphs instead of fetching the same footway network repeatedly
- **Fast common radii** — precomputed polygons can ship with the app for common stop radii, with automatic fallback to live calculation
- **Circle mode** — simple air-line radius as a faster alternative
- **Custom stops** — click anywhere on the map to add your own stops and choose their type
- **Per-stop walkshed toggle** — hide or show the walkshed polygon for an individual stop from its popup, persisted across reloads
- **Configurable walking distance per type** — set separate values for tram, train, and bus (50 m to 5000 m)
- **Type filters in the legend** — show/hide train, tram, and bus markers with persisted state across reloads
- **Smart cache invalidation** — moving/removing custom stops only invalidates affected walkshed cache entries
- **Fully static** — no backend required, deploys to GitHub Pages
- **Vector basemap** — rendered client-side with MapLibre GL JS and OpenFreeMap
- **Persistent client cache for API protection** — walkshed polygons are cached in IndexedDB (with localStorage fallback) and can be reset from the config page
- **Temporary backoff on failures** — unavailable walksheds are cached briefly to avoid repeated API retries

## Getting Started

```sh
npm install
npm run update:stops   # fetch stop data from Overpass API
npm run build:walksheds # optionally refresh the shipped common-radius polygons
npm run dev            # start dev server
```

## Build

```sh
npm run build
npm run preview
```

The map uses OpenFreeMap's Liberty style by default. To use another MapLibre-compatible style,
set its URL at build time:

```sh
PUBLIC_MAP_STYLE_URL=https://example.com/style.json npm run build
```

`PUBLIC_MAP_STYLE_URL` is embedded in the client bundle. Use a public style URL and never put a
private provider token in this value. The Astro output remains static: browsers load the style and
vector tiles directly from the configured provider.

## Formatting

```sh
npm run format        # apply formatting
npm run format:check  # verify formatting in CI
```

Type-check the Astro and TypeScript sources with:

```sh
npm run check
```

Run the unit tests with:

```sh
npm test
```

### GitHub Pages

```sh
BASE_PATH=/ka-laufweite SITE_URL=https://username.github.io npm run build
```

Automated deployment workflow: `.github/workflows/deploy-pages.yml`

After pushing to GitHub, one-time setup:

1. Open repository `Settings` -> `Pages`.
2. Set `Source` to `GitHub Actions`.
3. Ensure your default branch is `main` (or adjust the workflow trigger branch).
4. Push to `main` (or run the workflow manually from `Actions`).

The workflow computes `BASE_PATH` and `SITE_URL` automatically for GitHub Pages, builds Astro as static output, uploads `dist/`, and deploys it.

## Updating Stop Data

Stop positions are fetched from the Overpass API and stored as a static JSON snapshot. To refresh:

```sh
npm run update:stops
```

This queries OSM for `railway=tram_stop`, `railway=station`, `railway=halt`, `highway=bus_stop`, and `amenity=bus_station` in the KVV bounding box.

To rebuild the optional shipped polygon snapshot for the current stops and supported radii, run
`npm run build:walksheds`. It writes one file per stop type and radius — for example,
`public/data/walksheds-train-450.json` — so the map only downloads the exact dataset selected by the
user (bus is hidden by default and loads lazily). Train ships radii from 400 m through 600 m, tram
from 300 m through 500 m, and bus from 200 m through 300 m, all in 50 m increments. The generator accepts `--types`, `--radius`, `--limit`,
`--concurrency`, and `--out-dir` options after `--`. Use `--types` to build a subset — e.g.
`--types train,tram` —
leaving the other types' files untouched (handy because bus has by far the most stops). `--radius`
can select one configured radius when exactly one type is selected. Its output is versioned,
validated at runtime, and keyed by stop type and coordinates so stale polygons are ignored after a
stop changes.

The stop snapshot is refreshed automatically on the first day of every month. On the second day, a
separate workflow rebuilds each shipped type/radius combination in parallel and makes one verified
commit after all jobs succeed. Both workflows can also be started manually from GitHub Actions.

## Tech Stack

- [Astro](https://astro.build) — static site generator
- [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/) — client-side vector map rendering
- [OpenFreeMap](https://openfreemap.org) — default OpenStreetMap vector basemap
- [Overpass API](https://overpass-api.de) — OSM data for stops and footpaths
- TypeScript

## How Walksheds Work

1. When stops become visible, matching shipped or browser-cached polygons are loaded first.
2. Remaining nearby stops are grouped into bounded batches. Each batch shares one padded Overpass query area and one footway network response; endpoints are scored by latency and failures.
3. A spatially indexed walk graph is built from the OSM ways and nodes and cached in memory with LRU limits.
4. Each stop is projected onto its nearest walkable edge and receives its own graph seeds and walking radius.
5. Dijkstra's shortest-path algorithm computes reachable nodes for every stop independently. Polygon calculation runs in a Web Worker when supported, with a synchronous compatibility fallback.
6. Boundary points are collected from the settled subgraph where the walking budget runs out, including interpolated edge cutoffs.
7. A concave hull wraps the boundary points into a polygon, with a convex hull as fallback.

Batching does not change walkshed correctness: query bounds contain every stop and are padded by a radius bucket plus a safety margin, so routes reachable within each requested radius are not truncated at the query boundary.

## Map Rendering

- Built-in stops share one GeoJSON source and MapLibre circle layer.
- Custom stops use draggable DOM markers because they require direct pointer interaction.
- Radius coverage, loading placeholders, and walksheds are GeoJSON polygon sources.
- Viewport changes batch polygon source updates to avoid repeatedly rebuilding MapLibre data.
- Walkshed computation and persistence are independent from the basemap provider.

## Cache Behavior

- Walkshed polygons and temporary "unavailable" results are persisted in browser storage
- Primary storage is IndexedDB (`karlsruhe-opnv-walkshed-cache-v1`); localStorage is only used as fallback
- Cache entries are pruned after 30 days and capped by size (4000 total entries, max 1000 unavailable entries)
- Temporary unavailable results use retry windows (2 minutes for transient failures, 24 hours for no-data cases)
- Raw Overpass responses and walk graphs are runtime-only, weighted-LRU cached, and never persisted
- Cache can be cleared from the config page (`Cache zurücksetzen`)

## Project Structure

```
src/
  components/
    StopLegendItems.astro       # legend rows generated from shared stop-type config
    StopRadiusInputs.astro      # reusable radius input fields per stop type
    PopupStyles.astro           # shared popup styling injected into the map page
  pages/
    index.astro                 # map page
    config.astro                # settings page
  layouts/
    Layout.astro                # shared shell and navigation
  scripts/
    map.ts                      # map controller and interaction logic
    config.ts                   # settings page behavior
    map/
      custom-stop-marker-icon.ts   # custom marker element builder for draggable stops
      map-geometry.ts              # GeoJSON and geodesic circle helpers
      walkshed-overlay-manager.ts  # async polygon loading and rendering
  lib/
    types.ts                    # shared types and type guards
    storage.ts                  # safe localStorage + JSON read/write wrappers
    settings.ts                 # user preferences (radius, coverage mode, type visibility)
    stop-type-config.ts         # single source of truth for stop-type labels/colors/inputs
    stops-repository.ts         # stop loading (OSM + custom)
    custom-stops-client.ts      # localStorage CRUD + migration for custom stops
    walkshed-disabled-stops.ts  # per-stop walkshed visibility persistence
    map-popups.ts               # popup HTML templates
    walkshed-cache.ts           # cache policy + invalidation + reset marker sync
    walkshed-cache-persistence.ts # IndexedDB/localStorage persistence adapter
    walkshed/
      service.ts                # requests, results, batching orchestration, and runtime caches
      cache-key.ts              # shared cache-key format (stop id + radius)
      shipped-walksheds.ts      # validated loader for precomputed common-radius polygons
      walkshed-codec.ts         # compact shipped-polygon format and validation
      overpass.ts               # footway-network client with endpoint scoring
      query-area.ts             # radius buckets, padded bounds, and shared area keys
      graph.ts                  # graph construction, spatial edge index, and Dijkstra
      polygon.ts                # boundary collection and hull generation
      polygon-calculation.ts    # per-stop graph routing and polygon calculation
      polygon-calculation-worker.ts # worker-side graph cache and calculations
      polygon-calculation-worker-client.ts # worker lifecycle and requests
      polygon-calculation-worker-protocol.ts # typed worker messages
      geo.ts                    # haversine, bounding-box, and coordinate math
      priority-queue.ts         # minimum-distance heap for Dijkstra
      weighted-lru-cache.ts     # bounded runtime cache utility
      constants.ts              # algorithm parameters
      types.ts                  # walkshed-specific types
scripts/
  update-osm-stops.mjs          # CLI script to refresh stop data
public/
  data/osm-stops.json           # static stop snapshot
  data/walksheds-*.json         # optional shipped polygons by stop type and radius
```

## License

MIT
