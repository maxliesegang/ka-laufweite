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
- Walkshed response cache: `src/lib/walkshed-cache.ts` (localStorage, resettable via config page, supports per-stop invalidation)
- Map orchestration: `src/scripts/map.ts`
- Map UI helpers: `src/scripts/map/custom-stop-marker-icon.ts`
- Walkshed overlay orchestration: `src/scripts/map/walkshed-overlay-manager.ts`
- Config page logic: `src/scripts/config.ts`
- Shared settings/types: `src/lib/settings.ts` (radius, coverage shape, stop-type visibility), `src/lib/types.ts`

## Required Practices

- Prefer TypeScript with explicit, narrow types.
- Validate external JSON before use.
- Keep map behavior deterministic and resilient to missing data.
- Preserve static-site compatibility (no server-only routes/dependencies).
- Use `import.meta.env.BASE_URL` for in-app links and static asset paths.

## Data Refresh Workflow

- OSM snapshot generator: `scripts/update-osm-stops.mjs`
- Refresh data with:

```sh
npm run update:stops
```

## Verification

Before finishing changes, run:

```sh
npm run build
```

For GitHub Pages-style build checks:

```sh
BASE_PATH=/ka-laufweite SITE_URL=https://<username>.github.io npm run build
```

## License

This project is MIT licensed. Keep `LICENSE` intact and ensure new files remain MIT-compatible.
