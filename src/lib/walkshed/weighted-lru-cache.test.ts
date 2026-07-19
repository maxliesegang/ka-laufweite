import { describe, expect, it } from 'vitest';
import { WeightedLruCache } from './weighted-lru-cache';

describe('WeightedLruCache', () => {
  it('evicts the least recently used entry when the entry limit is exceeded', () => {
    const cache = new WeightedLruCache<string, number>(2, 100);
    cache.set('old', 1, 1);
    cache.set('kept', 2, 1);
    expect(cache.get('old')).toBe(1);

    expect(cache.set('new', 3, 1)).toEqual(['kept']);
    expect(cache.get('kept')).toBeUndefined();
    expect(cache.get('old')).toBe(1);
    expect(cache.get('new')).toBe(3);
  });

  it('tracks replacement weights without double-counting them', () => {
    const cache = new WeightedLruCache<string, number>(3, 10);
    cache.set('replaced', 1, 8);
    cache.set('replaced', 2, 2);

    expect(cache.set('other', 3, 8)).toEqual([]);
    expect(cache.size).toBe(2);
  });

  it('retains one oversized newest entry', () => {
    const cache = new WeightedLruCache<string, number>(3, 10);
    cache.set('old', 1, 5);

    expect(cache.set('oversized', 2, 20)).toEqual(['old']);
    expect(cache.size).toBe(1);
    expect(cache.get('oversized')).toBe(2);
  });
});
