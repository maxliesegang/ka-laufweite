import { describe, expect, it } from 'vitest';
import { walkshedCacheKey, walkshedCacheKeyPrefixForStop } from './cache-key';

describe('walkshed cache keys', () => {
  it('change when a stop moves while retaining stop-wide invalidation', () => {
    const before = walkshedCacheKey('custom-1', 500, 49, 8);
    const after = walkshedCacheKey('custom-1', 500, 49.001, 8);
    expect(after).not.toBe(before);
    expect(before.startsWith(walkshedCacheKeyPrefixForStop('custom-1'))).toBe(true);
    expect(after.startsWith(walkshedCacheKeyPrefixForStop('custom-1'))).toBe(true);
  });
});
