# KA Laufweite

Interactive map showing walkable coverage around every tram and train stop in the KVV network (Karlsruhe region). Instead of simple radius circles, it calculates real walking distances along OpenStreetMap footpaths — so you see what you can actually reach on foot.

Live site: [maxliesegang.github.io/ka-laufweite](https://maxliesegang.github.io/ka-laufweite/)

## Features

- **Walkshed polygons** — coverage areas based on real walkable paths from OSM, computed via Dijkstra's algorithm and concave hull generation
- **Circle mode** — simple air-line radius as a faster alternative
- **Custom stops** — click anywhere on the map to add your own stops
- **Configurable walking distance** — adjust from 50 m to 5000 m
- **Fully static** — no backend required, deploys to GitHub Pages
- **Offline caching** — walkshed results are cached in localStorage for instant revisits

## Getting Started

```sh
npm install
npm run update:stops   # fetch stop data from Overpass API
npm run dev            # start dev server
```

## Build

```sh
npm run build
npm run preview
```

## Formatting

```sh
npm run format        # apply formatting
npm run format:check  # verify formatting in CI
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

This queries OSM for all `railway=tram_stop`, `railway=station`, and `railway=halt` nodes in the KVV bounding box.

## Tech Stack

- [Astro](https://astro.build) — static site generator
- [Leaflet](https://leafletjs.com) — map rendering
- [Overpass API](https://overpass-api.de) — OSM data for stops and footpaths
- TypeScript

## How Walksheds Work

1. When a stop becomes visible on the map, footpath data is fetched from the Overpass API
2. A walk graph is built from OSM ways and nodes
3. Dijkstra's shortest path algorithm computes reachable distances from the nearest graph node
4. Boundary points are collected where the walking budget runs out (including interpolated edge cutoffs)
5. A concave hull wraps the boundary points into a polygon, with convex hull as fallback

## Project Structure

```
src/
  pages/
    index.astro                 # map page
    config.astro                # settings page
  layouts/
    Layout.astro                # shared shell and navigation
  scripts/
    map.ts                      # map controller and interaction logic
    config.ts                   # settings page behavior
    map/
      walkshed-overlay-manager.ts  # async polygon loading and rendering
  lib/
    types.ts                    # shared types and type guards
    settings.ts                 # user preferences (radius, coverage mode)
    stops-repository.ts         # stop loading (OSM + custom)
    custom-stops-client.ts      # localStorage CRUD for custom stops
    map-config.ts               # map constants, colors, marker sizes
    map-popups.ts               # popup HTML templates
    walkshed-cache.ts           # localStorage polygon cache
    walkshed/
      service.ts                # walkshed orchestration and caching
      overpass.ts               # Overpass API client
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
