import { afterEach, describe, expect, it, vi } from 'vitest';
import { OVERPASS_ENDPOINT_URLS } from './constants';
import { fetchFootwayNetwork, isWalkableFootwayTags, parseOverpassResponse } from './overpass';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Overpass response validation', () => {
  it('accepts a valid empty response as valid no-data', () => {
    expect(parseOverpassResponse({ elements: [] })).toEqual({ elements: [] });
  });

  it('rejects partial or malformed element arrays', () => {
    expect(
      parseOverpassResponse({
        elements: [
          { type: 'node', id: 1, lat: 49, lon: 8 },
          { type: 'way', id: 2, nodes: ['invalid'] },
        ],
      }),
    ).toBeNull();
  });
});

describe('walkable footway tag filter', () => {
  it.each([
    [{ highway: 'footway' }, true],
    [{ highway: 'residential', access: 'destination', foot: 'yes' }, true],
    [{}, false],
    [{ highway: 'motorway' }, false],
    [{ highway: 'trunk_link' }, false],
    [{ highway: 'pedestrian', area: 'yes' }, false],
    [{ highway: 'footway', indoor: 'yes' }, false],
    [{ highway: 'service', access: 'private' }, false],
    // Overpass `!~` is an unanchored regex match, so substrings count.
    [{ highway: 'track', access: 'agricultural;no' }, false],
    [{ highway: 'cycleway', foot: 'no' }, false],
  ])('%o → %s', (tags, expected) => {
    expect(isWalkableFootwayTags(tags)).toBe(expected);
  });
});

describe('Overpass request resilience', () => {
  it('retries temporary failures after trying each endpoint', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi.fn<typeof fetch>();
    for (const _endpoint of OVERPASS_ENDPOINT_URLS) {
      fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    }
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ elements: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchFootwayNetwork(49, 8, 300);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual({ status: 'ok', networkData: { elements: [] } });
    expect(fetchMock).toHaveBeenCalledTimes(OVERPASS_ENDPOINT_URLS.length + 1);
  });

  it('does not retry a permanent query error', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchFootwayNetwork(49, 8, 300)).resolves.toEqual({
      status: 'all-endpoints-failed',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('tries a slow healthy endpoint before a failing one', async () => {
    vi.resetModules();
    const { fetchFootwayNetwork: fetchWithFreshStats } = await import('./overpass');
    vi.useFakeTimers();
    const slowEndpointUrl = OVERPASS_ENDPOINT_URLS.at(-1);
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input !== slowEndpointUrl) return new Response('', { status: 504 });
      // Slower than the failure penalty a never-successful endpoint accrues.
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = fetchWithFreshStats(49, 8, 300);
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(first).resolves.toMatchObject({ status: 'ok' });

    fetchMock.mockClear();
    const second = fetchWithFreshStats(49, 8, 300);
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(second).resolves.toMatchObject({ status: 'ok' });
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([slowEndpointUrl]);
  });

  it('does not start work with an aborted signal', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(fetchFootwayNetwork(49, 8, 300, controller.signal)).rejects.toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
