import { describe, expect, it } from 'vitest';

describe('test environment', () => {
  it('runs in jsdom with sessionStorage', () => {
    sessionStorage.setItem('k', 'v');
    expect(sessionStorage.getItem('k')).toBe('v');
  });
});
