# KA Laufweite

Interactive map showing walkable coverage around tram, train, and bus stops in the KVV network (Karlsruhe region). Instead of simple radius circles, it calculates real walking distances along OpenStreetMap footpaths — so you see what you can actually reach on foot.

Live site: [maxliesegang.github.io/ka-laufweite](https://maxliesegang.github.io/ka-laufweite/)

## Features

- **Walkshed polygons** — coverage areas based on real walkable paths from OSM, computed via Dijkstra's algorithm and concave hull generation
- **Fast defaults** — precomputed polygons can ship with the app for the default stop radii, with automatic fallback to live calculation
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
npm run build:walksheds # optionally refresh the shipped default polygons
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

To rebuild the optional shipped polygon snapshot for the current stops and default settings, run
`npm run build:walksheds`. It writes one file per stop type — `public/data/walksheds-{train,tram,bus}.json` —
so the map only downloads the polygons for the types it currently shows (bus is hidden by default and
loads lazily). The generator accepts `--types`, `--limit`, `--concurrency`, and `--out-dir` options
after `--`. Use `--types` to build a subset — e.g. `--types train,tram` — leaving the other types'
files untouched (handy because bus has by far the most stops). Its output is versioned, validated at
runtime, and keyed by stop type and coordinates so stale polygons are ignored after a stop changes.

The stop snapshot is refreshed automatically on the first day of every month. The workflow commits verified data changes to the default branch and can also be started manually from GitHub Actions.

## Tech Stack

- [Astro](https://astro.build) — static site generator
- [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/) — client-side vector map rendering
- [OpenFreeMap](https://openfreemap.org) — default OpenStreetMap vector basemap
- [Overpass API](https://overpass-api.de) — OSM data for stops and footpaths
- TypeScript

## How Walksheds Work

1. When a stop becomes visible on the map, a matching shipped or browser-cached polygon is used when available; otherwise footpath data is fetched from the Overpass API (endpoints are scored by latency/failures and the fastest is preferred)
2. A walk graph is built from OSM ways and nodes
3. Dijkstra's shortest path algorithm computes reachable distances, seeded from the nearest walkable node(s) near the stop
4. Boundary points are collected where the walking budget runs out (including interpolated edge cutoffs)
5. A concave hull wraps the boundary points into a polygon, with convex hull as fallback

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
      service.ts                # walkshed orchestration and caching
      cache-key.ts              # shared cache-key format (stop id + distance)
      shipped-walksheds.ts      # validated loader for precomputed default polygons
      walkshed-codec.ts         # compact shipped-polygon format and validation
      overpass.ts               # Overpass API client with endpoint scoring
      graph.ts                  # graph construction, nearest node, Dijkstra
      polygon.ts                # boundary collection and hull generation
      geo.ts                    # haversine, bbox, coordinate math
      priority-queue.ts         # min-heap for Dijkstra
      constants.ts              # algorithm parameters
      types.ts                  # walkshed-specific types
scripts/
  update-osm-stops.mjs          # CLI script to refresh stop data
public/
  data/osm-stops.json           # static stop snapshot
```

## License

MIT
