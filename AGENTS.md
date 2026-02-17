# AGENTS.md

Guidance for coding agents and contributors working in this repository.

## Scope

- Build and maintain a static Astro app for Karlsruhe OPNV stops.
- Keep the app compatible with GitHub Pages deployments.

## Core Architecture

- Runtime stop data source: `public/data/osm-stops.json`
- Runtime custom stops: browser `localStorage` (see `src/lib/custom-stops-client.ts`)
- Stop access and validation: `src/lib/stops-repository.ts`
- Map popup templates: `src/lib/map-popups.ts`
- Stop-type metadata and UI building blocks: `src/lib/stop-type-config.ts`, `src/components/StopLegendItems.astro`, `src/components/StopRadiusInputs.astro`, `src/components/PopupStyles.astro`
- Walkshed polygon generation: `src/lib/walkshed/service.ts` with helpers in `src/lib/walkshed/*` (Overpass + footpath graph)
- Walkshed response cache policy: `src/lib/walkshed-cache.ts` (entry lifecycle, per-stop invalidation, reset marker sync)
- Walkshed cache persistence: `src/lib/walkshed-cache-persistence.ts` (IndexedDB primary, localStorage fallback)
- Map orchestration: `src/scripts/map.ts`
- Map UI helpers: `src/scripts/map/custom-stop-marker-icon.ts`
- Walkshed overlay orchestration: `src/scripts/map/walkshed-overlay-manager.ts`
- Config page logic: `src/scripts/config.ts`
- Shared settings/types: `src/lib/settings.ts` (radius, coverage shape, stop-type visibility), `src/lib/types.ts`

### Walkshed cache specifics

- Cache backend: IndexedDB database `karlsruhe-opnv-walkshed-cache-v1` (store `entries`)
- localStorage remains for lightweight settings, reset marker sync, and as persistence fallback when IndexedDB is unavailable
- Cache pruning rules: max age 30 days, max 4000 total entries, max 1000 temporary "unavailable" entries
- Temporary unavailable retry windows are managed in `src/lib/walkshed/service.ts` (currently 2 minutes transient, 24 hours no-data)

## Required Practices

- Prefer TypeScript with explicit, narrow types.
- Validate external JSON before use.
- Keep map behavior deterministic and resilient to missing data.
- Preserve static-site compatibility (no server-only routes/dependencies).
- Use `import.meta.env.BASE_URL` for in-app links and static asset paths.
- Keep async cache operations awaited where correctness depends on write ordering (for example cache invalidation before re-render).

## Data Refresh Workflow

- OSM snapshot generator: `scripts/update-osm-stops.mjs`
- Refresh data with:

```sh
npm run update:stops
```

## Verification

Before finishing changes, run:

```sh
npm run format:check
npm run build
```

For GitHub Pages-style build checks:

```sh
BASE_PATH=/ka-laufweite SITE_URL=https://<username>.github.io npm run build
```

## License

This project is MIT licensed. Keep `LICENSE` intact and ensure new files remain MIT-compatible.
