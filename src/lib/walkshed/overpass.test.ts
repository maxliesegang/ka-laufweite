import { afterEach, describe, expect, it, vi } from 'vitest';
import { OVERPASS_ENDPOINT_URLS } from './constants';
import { fetchFootways, parseOverpassResponse } from './overpass';

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

    const pending = fetchFootways(49, 8, 300);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual({ status: 'ok', response: { elements: [] } });
    expect(fetchMock).toHaveBeenCalledTimes(OVERPASS_ENDPOINT_URLS.length + 1);
  });

  it('does not retry a permanent query error', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchFootways(49, 8, 300)).resolves.toEqual({
      status: 'all-endpoints-failed',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not start work with an aborted signal', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(fetchFootways(49, 8, 300, controller.signal)).rejects.toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
