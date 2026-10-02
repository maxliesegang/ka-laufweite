/**
 * Footway network data read from a local OSM extract instead of Overpass. The
 * build fetches one regional extract up front (`scripts/prepare-osm-extract.ts`)
 * and answers every batch query from memory, so it no longer depends on public
 * Overpass instances that throttle or time out under thousands of requests.
 *
 * `footwayNetworkInBounds` reproduces what the runtime's Overpass query returns
 * for the same bounds: the same tag filter (`isWalkableFootwayTags`), ways that
 * have a node inside or a segment crossing the bounds, every node of those
 * ways, and Overpass' output order (nodes, then ways, each by ascending id).
 */
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { isWalkableFootwayTags } from '../../src/lib/walkshed/overpass.ts';
import type {
  BoundingBox,
  OverpassNodeElement,
  OverpassResponse,
  OverpassWayElement,
} from '../../src/lib/walkshed/types.ts';

export const DEFAULT_OSM_CACHE_DIR = join(import.meta.dirname, '..', '..', '.cache', 'osm');
export const FOOTWAY_EXTRACT_FILENAME = 'footways.opl';
export const FOOTWAY_EXTRACT_METADATA_FILENAME = 'footways.json';

/** Written next to the extract so the build knows which area it may query. */
export interface FootwayExtractMetadata {
  bounds: BoundingBox;
  regions: string[];
  generatedAt: string;
}

const GRID_CELL_DEGREES = 0.02;

interface LocalWay {
  id: number;
  nodeIndexes: Int32Array;
  tags: Record<string, string>;
}

export interface LocalFootwayNetwork {
  metadata: FootwayExtractMetadata;
  wayCount: number;
  nodeCount: number;
  /** Way references to nodes missing from the extract; expected to be zero. */
  missingNodeReferenceCount: number;
  /** Throws when `bounds` leaves the extract: a silently truncated network
   *  would produce wrong walksheds, not missing ones. */
  footwayNetworkInBounds: (bounds: BoundingBox) => OverpassResponse;
}

/** OPL escapes special characters in tag text as `%<hex code point>%`. */
function decodeOplText(text: string): string {
  return text.includes('%')
    ? text.replace(/%([0-9a-fA-F]+)%/g, (_, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16)),
      )
    : text;
}

function parseOplTags(field: string): Record<string, string> {
  const tags: Record<string, string> = {};
  if (field.length === 0) return tags;
  for (const pair of field.split(',')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex < 0) continue;
    tags[decodeOplText(pair.slice(0, separatorIndex))] = decodeOplText(
      pair.slice(separatorIndex + 1),
    );
  }
  return tags;
}

/** Field values of one OPL line keyed by their one-letter prefix. */
function oplFields(tokens: string[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (let tokenIndex = 1; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    fields.set(token[0], token.slice(1));
  }
  return fields;
}

function boundsContain(outer: BoundingBox, inner: BoundingBox): boolean {
  return (
    inner.south >= outer.south &&
    inner.west >= outer.west &&
    inner.north <= outer.north &&
    inner.east <= outer.east
  );
}

function isPointInBounds(lat: number, lon: number, bounds: BoundingBox): boolean {
  return lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east;
}

/** Liang–Barsky clip: whether the segment touches the box anywhere. */
export function segmentIntersectsBounds(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
  bounds: BoundingBox,
): boolean {
  const deltaLon = toLon - fromLon;
  const deltaLat = toLat - fromLat;
  let entry = 0;
  let exit = 1;
  const edges: Array<[number, number]> = [
    [-deltaLon, fromLon - bounds.west],
    [deltaLon, bounds.east - fromLon],
    [-deltaLat, fromLat - bounds.south],
    [deltaLat, bounds.north - fromLat],
  ];
  for (const [direction, distance] of edges) {
    if (direction === 0) {
      if (distance < 0) return false;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) entry = Math.max(entry, ratio);
    else exit = Math.min(exit, ratio);
    if (entry > exit) return false;
  }
  return true;
}

function gridCellKey(latCell: number, lonCell: number): number {
  return latCell * 100_000 + lonCell;
}

export async function loadLocalFootwayNetwork(cacheDir: string): Promise<LocalFootwayNetwork> {
  const metadata = JSON.parse(
    await readFile(join(cacheDir, FOOTWAY_EXTRACT_METADATA_FILENAME), 'utf8'),
  ) as FootwayExtractMetadata;

  const nodeIds: number[] = [];
  const nodeLats: number[] = [];
  const nodeLons: number[] = [];
  const parsedWays: Array<{ id: number; nodeIds: number[]; tags: Record<string, string> }> = [];

  const lines = createInterface({
    input: createReadStream(join(cacheDir, FOOTWAY_EXTRACT_FILENAME)),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const kind = line[0];
    if (kind !== 'n' && kind !== 'w') continue;
    const tokens = line.split(' ');
    const id = Number(tokens[0].slice(1));
    const fields = oplFields(tokens);
    if (kind === 'n') {
      const lon = Number(fields.get('x'));
      const lat = Number(fields.get('y'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (nodeIds.length > 0 && id <= nodeIds[nodeIds.length - 1]) {
        throw new Error(`OPL nodes are not sorted by id at n${id}`);
      }
      nodeIds.push(id);
      nodeLats.push(lat);
      nodeLons.push(lon);
    } else {
      const tags = parseOplTags(fields.get('T') ?? '');
      if (!isWalkableFootwayTags(tags)) continue;
      const nodeRefs = fields.get('N') ?? '';
      const wayNodeIds =
        nodeRefs.length === 0 ? [] : nodeRefs.split(',').map((ref) => Number(ref.slice(1)));
      parsedWays.push({ id, nodeIds: wayNodeIds, tags });
    }
  }

  const sortedNodeIds = Float64Array.from(nodeIds);
  const lats = Float64Array.from(nodeLats);
  const lons = Float64Array.from(nodeLons);
  const findNodeIndex = (nodeId: number): number => {
    let low = 0;
    let high = sortedNodeIds.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const middleId = sortedNodeIds[middle];
      if (middleId === nodeId) return middle;
      if (middleId < nodeId) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  };

  let missingNodeReferenceCount = 0;
  const ways: LocalWay[] = [];
  const wayIndexesByGridCell = new Map<number, number[]>();
  for (const parsedWay of parsedWays.sort((first, second) => first.id - second.id)) {
    const nodeIndexes: number[] = [];
    for (const nodeId of parsedWay.nodeIds) {
      const nodeIndex = findNodeIndex(nodeId);
      if (nodeIndex < 0) missingNodeReferenceCount += 1;
      else nodeIndexes.push(nodeIndex);
    }
    if (nodeIndexes.length === 0) continue;

    const wayIndex = ways.length;
    ways.push({
      id: parsedWay.id,
      nodeIndexes: Int32Array.from(nodeIndexes),
      tags: parsedWay.tags,
    });

    let south = Infinity;
    let west = Infinity;
    let north = -Infinity;
    let east = -Infinity;
    for (const nodeIndex of nodeIndexes) {
      south = Math.min(south, lats[nodeIndex]);
      north = Math.max(north, lats[nodeIndex]);
      west = Math.min(west, lons[nodeIndex]);
      east = Math.max(east, lons[nodeIndex]);
    }
    for (
      let latCell = Math.floor(south / GRID_CELL_DEGREES);
      latCell <= Math.floor(north / GRID_CELL_DEGREES);
      latCell += 1
    ) {
      for (
        let lonCell = Math.floor(west / GRID_CELL_DEGREES);
        lonCell <= Math.floor(east / GRID_CELL_DEGREES);
        lonCell += 1
      ) {
        const cellKey = gridCellKey(latCell, lonCell);
        const cellWayIndexes = wayIndexesByGridCell.get(cellKey);
        if (cellWayIndexes) cellWayIndexes.push(wayIndex);
        else wayIndexesByGridCell.set(cellKey, [wayIndex]);
      }
    }
  }

  const wayIntersectsBounds = (way: LocalWay, bounds: BoundingBox): boolean => {
    const { nodeIndexes } = way;
    for (const nodeIndex of nodeIndexes) {
      if (isPointInBounds(lats[nodeIndex], lons[nodeIndex], bounds)) return true;
    }
    for (let position = 1; position < nodeIndexes.length; position += 1) {
      const fromNodeIndex = nodeIndexes[position - 1];
      const toNodeIndex = nodeIndexes[position];
      if (
        segmentIntersectsBounds(
          lats[fromNodeIndex],
          lons[fromNodeIndex],
          lats[toNodeIndex],
          lons[toNodeIndex],
          bounds,
        )
      ) {
        return true;
      }
    }
    return false;
  };

  // Stamping avoids allocating a de-duplication set per query.
  const visitedStampByWayIndex = new Uint32Array(ways.length);
  let queryStamp = 0;

  const footwayNetworkInBounds = (bounds: BoundingBox): OverpassResponse => {
    if (!boundsContain(metadata.bounds, bounds)) {
      throw new Error(
        `Query bounds ${JSON.stringify(bounds)} leave the OSM extract ` +
          `${JSON.stringify(metadata.bounds)}; widen FOOTWAY_EXTRACT_BOUNDS and re-run prepare:osm-extract`,
      );
    }
    queryStamp += 1;
    const selectedWayIndexes: number[] = [];
    for (
      let latCell = Math.floor(bounds.south / GRID_CELL_DEGREES);
      latCell <= Math.floor(bounds.north / GRID_CELL_DEGREES);
      latCell += 1
    ) {
      for (
        let lonCell = Math.floor(bounds.west / GRID_CELL_DEGREES);
        lonCell <= Math.floor(bounds.east / GRID_CELL_DEGREES);
        lonCell += 1
      ) {
        for (const wayIndex of wayIndexesByGridCell.get(gridCellKey(latCell, lonCell)) ?? []) {
          if (visitedStampByWayIndex[wayIndex] === queryStamp) continue;
          visitedStampByWayIndex[wayIndex] = queryStamp;
          if (wayIntersectsBounds(ways[wayIndex], bounds)) selectedWayIndexes.push(wayIndex);
        }
      }
    }

    // Way and node indexes follow ascending OSM id, so sorting them sorts by id.
    selectedWayIndexes.sort((first, second) => first - second);
    const selectedNodeIndexes = new Set<number>();
    for (const wayIndex of selectedWayIndexes) {
      for (const nodeIndex of ways[wayIndex].nodeIndexes) selectedNodeIndexes.add(nodeIndex);
    }

    const nodeElements: OverpassNodeElement[] = [...selectedNodeIndexes]
      .sort((first, second) => first - second)
      .map((nodeIndex) => ({
        type: 'node',
        id: sortedNodeIds[nodeIndex],
        lat: lats[nodeIndex],
        lon: lons[nodeIndex],
      }));
    const wayElements: OverpassWayElement[] = selectedWayIndexes.map((wayIndex) => {
      const way = ways[wayIndex];
      return {
        type: 'way',
        id: way.id,
        nodes: Array.from(way.nodeIndexes, (nodeIndex) => sortedNodeIds[nodeIndex]),
        tags: way.tags,
      };
    });
    return { elements: [...nodeElements, ...wayElements] };
  };

  return {
    metadata,
    wayCount: ways.length,
    nodeCount: sortedNodeIds.length,
    missingNodeReferenceCount,
    footwayNetworkInBounds,
  };
}
