# AGENTS.md

Guidance for coding agents and contributors working in this repository.

## Scope

- Build and maintain a static Astro app for Karlsruhe OPNV stops.
- Keep the app compatible with GitHub Pages deployments.

## Core Architecture

- Runtime stop data source: `public/data/osm-stops.json`
- Runtime custom stops: browser `localStorage` (see `src/lib/custom-stops-client.ts`)
- Stop access and validation: `src/lib/stops-repository.ts`
- Map constants/templates: `src/lib/map-config.ts`, `src/lib/map-popups.ts`
- Walkshed polygon generation: `src/lib/walkshed.ts` (Overpass + footpath graph)
- Walkshed response cache: `src/lib/walkshed-cache.ts` (localStorage, resettable via config page)
- Map orchestration: `src/scripts/map.ts`
- Config page logic: `src/scripts/config.ts`
- Shared settings/types: `src/lib/settings.ts`, `src/lib/types.ts`

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
BASE_PATH=/karlsruhe-opnv-map SITE_URL=https://<username>.github.io npm run build
```

## License

This project is MIT licensed. Keep `LICENSE` intact and ensure new files remain MIT-compatible.
